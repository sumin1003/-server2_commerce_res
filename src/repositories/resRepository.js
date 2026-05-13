// src/repositories/resRepository.js

/**
 * =========================================================================
 * FanVerse - Reservation Repository Layer
 * =========================================================================
 * 담당: Prisma를 이용한 예약 관련 PostgreSQL(Server 1) 데이터 제어
 * 목적: Service 계층에서 DB 라이브러리(Prisma) 의존성을 완벽히 분리하기 위함.
 */
// 공용 설정을 불러오기만 하면 끝 (전역 커넥션 풀 사용)
const prisma = require('../config/prisma');

/**
 * [예약 생성 트랜잭션] (createReservationWithTransaction)
 * 선착순 예약의 핵심인 '조회 후 업데이트' 과정을 하나의 작업 단위(Atomic)로 묶음
 */
exports.createReservationWithTransaction = async (data) => {
    /**
     * [트랜잭션 격리]
     * $transaction을 사용하여 내부 로직(재고 확인 -> 차감 -> 예약 생성) 중 
     * 하나라도 실패하면 전체 과정을 롤백(Rollback)하여 데이터 정합성을 지킴.
     */
    return await prisma.$transaction(async (tx) => {
        
        // 1. [재고 확인 및 데이터 로드] 
        // 트랜잭션 내에서 최신 공연 데이터를 조회함.
        const event = await tx.events.findUnique({
            where: { event_id: data.event_id }
        });

        // [방어 로직] 존재하지 않는 공연이거나, 실시간 잔여석이 구매 수량보다 적으면 즉시 에러를 던져 중단함
        if (!event) throw new Error("존재하지 않는 공연입니다.");
        if (event.available_seats < data.ticket_count) {
            throw new Error("잔여석이 부족하여 예매할 수 없습니다.");
        }

        // 2. [재고 차감 (Update)]
        // DB의 원자적 연산(decrement)을 사용하여 available_seats 수치를 구매 수량만큼 줄임
        // 여러 요청이 동시에 들어와도 DB 레벨에서 안전하게 수량이 깎임.
        await tx.events.update({
            where: { event_id: data.event_id },
            data: {
                available_seats: {
                    decrement: data.ticket_count 
                }
            }
        });

        // 3. [예약 데이터 삽입 (Insert)]
        // 최종적으로 reservations 테이블에 예약 내역을 생성함. 초기 상태는 'PENDING(결제 대기)'으로 설정함.
        const reservation = await tx.reservations.create({
            data: {
                event_id: data.event_id,
                member_id: data.member_id,
                ticket_count: data.ticket_count,
                booking_fee: data.booking_fee,
                total_price: data.total_price,
                ticket_code: data.ticket_code,
                status: 'PENDING',
                selected_seats: data.selected_seats
            }
        });

        // Prisma 트랜잭션 성공 시 자동 COMMIT, 에러 발생 시 자동 ROLLBACK
        return reservation;
    });
};

/**
 * [보상 트랜잭션] 결제 실패 시 예약 취소 및 DB 재고 원복
 * RabbitMQ의 Cancel 큐를 수신했을 때 실행되어 시스템 상태를 복구함.
 */
exports.cancelReservationAndRestoreStock = async (ticket_code, event_id, ticket_count) => {
    /**
     * [복구 트랜잭션] 
     * 데이터 일관성을 위해 상태 변경(FAILED)과 재고 복구(+count)를 하나의 단위로 실행함
     */
    return await prisma.$transaction(async (tx) => {
        
        // 1. [현재 예약 상태 확인]
        // findFirst를 통해 취소하려는 티켓의 존재 여부를 먼저 파악함
        const reservation = await tx.reservations.findFirst({
            where: { ticket_code: ticket_code }
        });

        // [중복 취소 방지] 이미 취소되었거나 데이터가 없다면 무의미한 업데이트를 피하고 스킵함 (멱등성 보장)
        if (!reservation) {
            console.log(`⚠️ [Skip] 이미 취소되었거나 없는 예약입니다: ${ticket_code}`);
            return null; 
        }

        // 2. [예약 상태 변경]
        // 예약 내역의 PK(ID)를 기준으로 상태를 'FAILED(결제/예약 실패)'로 업데이트함
        const updatedRes = await tx.reservations.update({
            where: { reservation_id: reservation.reservation_id },
            data: { status: 'FAILED' }
        });

        // 3. [DB 재고 원복]
        // 취소된 티켓 수량만큼 events 테이블의 available_seats를 다시 증가(increment)시킴
        await tx.events.update({
            where: { event_id: event_id },
            data: { available_seats: { increment: ticket_count } }
        });

        // 핵심 주석: 상태 체크 후 취소 처리함으로써 재고 중복 복구 방지
        return updatedRes;
    });
};

/**
 * 1. [조회] 티켓 고유 코드로 단일 예약 정보 조회
 */
exports.findReservationByCode = async (ticket_code) => {
    /**
     * [단일 건 조회]
     * 고유 키인 ticket_code를 사용하여 특정 예약 건의 모든 정보를 불러옴
     */
    return await prisma.reservations.findUnique({
        where: { ticket_code: ticket_code }
    });
};

/**
 * 2. 환불 확정 및 좌석 복구 (트랜잭션)
 * 어드민 서버(Java)에서 환불 승인이 완료되었다는 메시지(MQ)를 받았을 때 실행됨.
 */
exports.completeRefund = async (ticket_code, event_id, ticket_count) => {
    /**
     * [환불 트랜잭션]
     * 결제 취소가 완료된 후 DB 상태를 'REFUNDED'로 바꾸고 좌석을 다시 시장에 내놓는 과정임
     */
    return await prisma.$transaction(async (tx) => {
        
        // [Step 1] 예약 상태 변경 
        // 특정 티켓의 상태를 환불 완료(REFUNDED)로 변경함
        const updatedRes = await tx.reservations.update({
            where: { ticket_code: ticket_code },
            data: { status: 'REFUNDED' } 
        });

        // [Step 2] DB 좌석 수 복구 
        // 해당 공연의 재고 수량을 환불된 수량만큼 다시 늘려줌(increment)
        await tx.events.update({
            where: { event_id: event_id },
            data: { 
                available_seats: { 
                    increment: ticket_count 
                } 
            }
        });

        return updatedRes;
    });
};

/**
 * [내 예매 내역 조회 - Repository]
 * 스키마 반영: image_role('POSTER'), venue 필드 대응
 * 유저 마이페이지에서 전체 예매 이력을 불러올 때 사용됨.
 */
exports.findReservationsByMemberId = async (memberId) => {
    // Prisma의 강력한 JOIN(include) 기능을 활용하여 연관된 공연, 장소, 포스터 이미지까지 한 번에 조회함
    return await prisma.reservations.findMany({
        where: { 
            member_id: BigInt(memberId) 
        },
        include: {
            events: {
                include: {
                    event_locations: true, // venue, address 포함
                    event_images: {
                        where: { image_role: 'POSTER' },
                        take: 1 // 포스터 1장만 가져오기
                    }
                }
            }
        },
        orderBy: { booked_at: 'desc' } // 스키마의 booked_at(예매일시) 기준 최신순 정렬
    });
};

// 특정 이벤트의 예매자 데이터만 DB에서 순수하게 조회 (아티스트 명단 다운로드용)
exports.findReservationsByEventId = async (eventId) => {
    // 결제까지 완벽히 끝난(CONFIRMED) 확정 명단만 조회함
    return await prisma.reservations.findMany({
        where:{
            event_id: parseInt(eventId),
            status: 'CONFIRMED'
        },
        select: { // 네트워크 페이로드를 줄이기 위해 꼭 필요한 컬럼만 선택(Select)
            reservation_id: true,
            member_id: true,
            status: true,
            booked_at: true,
            ticket_count: true
        }
    });
}

// [DB 조회] 특정 아티스트의 최근 5일 예매 내역 조회 (대시보드 통계용)
exports.getRecentReservationsByArtist = async (artistId, startDate) => {
  return await prisma.reservations.findMany({
    where: {
      events: { 
        artist_id: BigInt(artistId) 
      },
      booked_at: {
        gte: startDate
      },
      status: {
        in: ['CONFIRMED', 'PENDING']
      }
    },
    select: {
      booked_at: true,
      ticket_count: true 
    }
  });
};

/**
 * [상태 조회] 티켓 코드로 현재 예약 상태 확인
 * 프론트엔드의 폴링(Polling) 서비스 및 상태 체크 로직에서 반복적으로 호출됨.
 */
exports.getStatusByTicketCode = async (ticketCode) => {
    /**
     * [단일 필드 조회 최적화]
     * ticket_code는 UNIQUE 제약조건이 걸려있어 findUnique로 고속 조회가 가능하며,
     * select를 통해 status 값 하나만 쏙 뽑아와서 DB 부하를 극한으로 줄임.
     */
    return await prisma.reservations.findUnique({
        where: { ticket_code: ticketCode },
        select: { status: true } //성능 최적화 핵심
    });
};

// [Repository] 관리자용 환불 대기(PENDING) 목록 조회
exports.findPendingRefunds = async () => {
    // 환불 테이블(reservation_refunds)을 메인으로 원본 예약 내역을 조인해서 가져옴
    return await prisma.reservation_refunds.findMany({
        where: { status: 'PENDING' },
        include: {
            reservations: {
                include: {
                    events: true // 이벤트 제목(title)까지 노출하기 위해 2단계 조인
                }
            }
        },
        orderBy: { created_at: 'desc' } // 최신 요청순 정렬
    });
};

// [어드민 환불완료 전체 조회]
exports.findCompletedRefunds = async () => {
    // 이미 파일 상단에 prisma가 선언되어 있지만, 기존 코드 존중을 위해 놔둠.
    const prisma = require('../config/prisma');
    
    // reservations(예약 원본) 기준으로 이미 상태가 REFUNDED로 바뀐 내역들을 조회함
    return await prisma.reservations.findMany({
        where: { status: 'REFUNDED' },
        include: {
            events: true, // 공연 정보 포함
            reservation_refunds: {   // 환불 사유/처리일(히스토리) 가져오기
                orderBy: { processed_at: 'desc' }, // 가장 마지막에 처리된 환불 내역 기준
                take: 1
            }
        },
        orderBy: { updated_at: 'desc' } // 최근 업데이트(환불 처리된) 순으로 정렬
    });
};

/**
 * 치명적 에러 방지용 함수
 * resService.js의 prepareRefundAdminRequest가 호출할 수 있도록 반드시 필요함!
 */
exports.createRefundAdminRequest = async (reservationId, memberId, refundAmount, refundReason) => {
    return await prisma.$transaction(async (tx) => {
        // a. 환불 테이블(reservation_refunds)에 승인 대기(PENDING) 상태로 기록 삽입
        const newRefund = await tx.reservation_refunds.create({
            data: {
                reservation_id: reservationId,
                member_id: BigInt(memberId),
                refund_amount: refundAmount,
                refund_reason: refundReason || "단순 변심",
                status: 'PENDING'
            }
        });

        // b. 기존 예약 내역(reservations) 상태를 REFUND_PENDING으로 변경하여 중복 취소 차단
        await tx.reservations.update({
            where: { reservation_id: reservationId },
            data: { status: 'REFUND_PENDING', updated_at: new Date() }
        });

        return newRefund;
    });
};

// 유저 대시보드용 [확정 예매 건수 조회]
exports.countConfirmedReservationsByUserId = async (userId) => {
    // Prisma의 count 메서드를 사용하여 조건에 맞는 레코드 개수만 반환
    return await prisma.reservations.count({
        where: {
            member_id: BigInt(userId),
            status: 'CONFIRMED'
        }
    });
};
