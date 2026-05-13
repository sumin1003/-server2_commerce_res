// src/services/resService.js
require('dotenv').config();
        
const resRepository = require('../repositories/resRepository');
const eventRepository = require('../repositories/eventRepository');
const redis = require('../config/redisClient');

/**
 * =========================================================================
 * [핵심] 예약 검증 및 준비 (validateAndPrepare)
 * =========================================================================
 * 목적: DB 부하를 줄이기 위해 Redis에서 재고를 선점하고, 결제 전 모든 자격을 검증함.
 * 흐름: Redis 재고 차감 -> 유저 세션 확인 -> 티켓 가격 계산 -> 유저 잔액 검증
 * 특징: 선착순 예매 특성상 트래픽이 몰릴 때 DB(PostgreSQL) 병목을 막기 위해 
 * 메모리 기반의 Redis를 최전선에 두는 아키텍처임.
 * -------------------------------------------------------------------------
 */
exports.validateAndPrepare = async (eventId, count, memberId) => {
    // 수량 제한 로직: 어뷰징 및 사재기를 막기 위해 1인당 최대 구매 수량을 2매로 제한
    if (count > 2) {
        throw { status: 400, message: "티켓은 1인당 최대 2매까지만 예매 가능합니다." };
    }

    // [식별자 구성] 특정 공연에 대한 Redis 재고 확인용 Key 생성
    const stockKey = `event:stock:${eventId}`;
    
    /**
     * [Step 1: Redis 원자적 재고 차감]
     * decrBy는 여러 서버가 동시에 요청해도 숫자가 꼬이지 않게 순차적으로 줄여주는 Atomic 연산임.
     * DB를 찌르기 전에 메모리에서 먼저 재고를 깎아 초당 수천 건의 예매 요청을 고속 처리할 수 있게 함.
     */
    const remainingStock = await redis.decrBy(stockKey, count);

    /**
     * [재고 부족 핸들링 (선착순 마감)]
     * 숫자가 0보다 작아졌다면 방금 내가 깎은 수량 때문에 재고가 바닥난 것임.
     * 즉시 다시 incrBy를 호출하여 재고를 복구(Rollback)하고 예약을 차단함.
     */
    if (remainingStock < 0) {
        await redis.incrBy(stockKey, count);
        throw { status: 400, message: "선착순 마감되었습니다. 재고가 부족합니다." };
    }

    try {
        /**
         * [Step 2: 유저 세션 및 프로필 조회]
         * Redis에 저장된 유저의 최신 상태(인증 여부, 잔액 등)를 Hash 형태로 가져옴.
         * 매번 User DB에 접근하지 않고 캐싱된 데이터를 사용하여 검증 속도를 높임.
         */
        const userKey = `AUTH:MEMBER:${memberId}`;
        const userProfile = await redis.hGetAll(userKey);

        // [인증 검증] 캐싱된 유저 세션 키가 없거나 데이터가 비어있다면 비정상 접근이므로 차단
        if (!userProfile || Object.keys(userProfile).length === 0) {
            throw { status: 401, message: "유저 정보를 찾을 수 없습니다. 다시 로그인해주세요." };
        }

        /**
         * [잔액 추출] Redis 프로필 데이터 중 포인트 잔액(balance)을 정수형으로 파싱하여 준비
         */
        const userBalance = parseInt(userProfile.balance, 10) || 0; 

        /**
         * [Step 3: 공연 정보 조회 및 금액 산출]
         * Repository를 통해 DB에서 공연의 기본 단가(price)를 가져옴.
         * 총 결제 금액 = (공연 단가 * 예매 매수) + (장당 수수료 * 예매 매수)
         */
        const event = await eventRepository.findEventById(eventId);
        if (!event) throw { status: 404, message: "공연 정보를 찾을 수 없습니다." };
        
        // [수수료 정책 조회] 결제 서버에 넘겨주기 위해 DB에서 아티스트 판매 수수료율 조회
        const feePolicy = await eventRepository.getFeePolicy(eventId);
        const salesCommissionRate = feePolicy ? feePolicy.sales_commission_rate : 0; // 정책 누락 방지

        // 예매 수수료(장당 1,000원 고정)와 최종 결제 금액 산출
        const bookingFee = count * 1000;
        const totalPrice = (event.price * count) + (count * 1000);

        /**
         * [Step 4: 결제 능력 사전 검증]
         * 결제 트랜잭션을 시작하기 전에 유저가 보유한 포인트가 충분한지 확인.
         * 무의미한 DB 트랜잭션을 줄이기 위한 예외 처리 방어선임.
         */
        if (userBalance < totalPrice) {
            throw { 
                status: 400, 
                message: `포인트가 부족합니다. (필요: ${totalPrice}P / 보유: ${userBalance}P)` 
            };
        }

        /**
         * [Step 5: 고유 티켓 코드 생성]
         * 결제 및 환불 시 식별자로 사용될 고유 코드 발급.
         * 형식: TKT-날짜(yyMMdd)-랜덤숫자(4자리) 조합으로 생성하여 가독성과 유일성을 동시에 확보함.
         */
        const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, ''); 
        const ticketCode = `TKT-${dateStr}-${Math.floor(Math.random() * 9000) + 1000}`;

        // [결과 반환] 모든 검증이 끝나면 Controller에서 MQ 메시지로 사용할 최종 명세서를 리턴
        return { 
            ticketCode: ticketCode,           // 통일 식별자
            memberId: Number(memberId),       
            totalPrice: totalPrice,           // 총 결제 금액
            quantity: count,                  // ticket_count 대신 quantity로 규격 통일
            artistId: event.artist_id,        
            ticketPrice: event.price,         // 순수 공연가
            salesCommissionRate: salesCommissionRate, 
            eventTitle: event.title,
            bookingFee: bookingFee            // DB 저장 전용 데이터
        };

    } catch (err) {
        /**
         * [보상 트랜잭션: Redis 부분 원복]
         * 금액 계산 실패, 잔액 부족 등으로 서비스 로직이 중단되었을 때,
         * 맨 처음 Step 1에서 깎아두었던 Redis 재고를 다시 채워넣어 다른 사람이 예매할 수 있게 함.
         */
        await redis.incrBy(stockKey, count);
        throw err;
    }
};

/**
 * =========================================================================
 * [티켓 예매 실행] DB에 PENDING 상태로 예약 데이터 저장 (makeReservation)
 * =========================================================================
 * 목적: Redis 메모리 검증이 끝난 데이터를 관계형 DB(PostgreSQL)에 영구 기록함.
 * 특징: 결제가 아직 확정되지 않았으므로 'PENDING(대기)' 상태로 스냅샷을 남김.
 * -------------------------------------------------------------------------
 */
exports.makeReservation = async (resData, memberId) => {
    /**
     * [DB 데이터 정제]
     * Repository 계층으로 넘기기 전, 모든 데이터를 정수형 등으로 안전하게 파싱하여 
     * DB 스키마 타입 불일치 에러를 방지함.
     */
    const dbData = {
        event_id: parseInt(resData.event_id, 10),
        ticket_count: parseInt(resData.ticket_count, 10),
        member_id: memberId,
        total_price: resData.totalPrice || resData.total_price,
        booking_fee: resData.bookingFee || resData.booking_fee,
        ticket_code: resData.ticketCode || resData.ticket_code,
        selected_seats: resData.selected_seats || null
    };

    /**
     * [DB 트랜잭션 실행]
     * Repository를 호출하여 '실제 DB 재고 차감'과 '예약 레코드 삽입'을 원자적(Atomic)으로 처리.
     */
    const dbResult = await resRepository.createReservationWithTransaction(dbData);

    /**
     * [데이터 바인딩]
     * 실제 DB에 저장된 최종 식별자와 금액 정보를 객체에 동기화.
     */
    resData.total_price = dbData.total_price;
    resData.ticket_code = dbData.ticket_code;

    console.log(`✅ [DB 저장 완료] 티켓번호: ${resData.ticket_code}`);

    /**
     * [결과 직렬화]
     * Prisma ORM의 BigInt 타입은 기본적으로 JSON.stringify 시 에러가 나므로
     * 프론트엔드로 안전하게 응답하기 위해 문자열(String)로 변환해 줌.
     */
    return JSON.parse(JSON.stringify(dbResult, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
    ));
};

/**
 * =========================================================================
 * [사용자 환불 요청 검증] 환불 자격 확인 (processRefund)
 * =========================================================================
 * 목적: 무분별한 환불 요청을 막기 위해 본인 소유 여부와 환불 가능 상태를 엄격히 검사함.
 * -------------------------------------------------------------------------
 */
exports.processRefund = async (ticketCode, memberId) => {
    // [유효성 검사] 필수 인자 누락 차단
    if (!ticketCode) throw { status: 400, message: "환불에 필요한 티켓 코드가 없습니다." };

    /**
     * [예약 데이터 조회]
     * 입력받은 코드로 DB에 저장된 실제 예약 원본 데이터를 확인함.
     */
    const reservation = await resRepository.findReservationByCode(ticketCode);
    
    // [부존재 예외] 조작된 티켓 코드 방어
    if (!reservation) throw { status: 404, message: "예매 내역을 찾을 수 없습니다." };
    
    /**
     * [소유권 검증 (보안)]
     * 요청자(memberId)와 티켓 소유자(reservation.member_id)를 비교하여 
     * 타인의 티켓을 악의적으로 환불하는 어뷰징 행위를 원천 차단함.
     */
    if (String(reservation.member_id) !== String(memberId)) {
        throw { status: 403, message: "본인의 예매 내역만 환불할 수 있습니다." };
    }
    
    /**
     * [상태 검증]
     * 이미 환불되었거나 결제 실패한 티켓을 중복 환불 처리하지 않도록 방어.
     */
    if (['REFUNDED', 'FAILED'].includes(reservation.status)) {
        throw { status: 400, message: "이미 환불되거나 취소된 티켓입니다." };
    }

    // [환불 정산 취소 데이터 준비] 관리자/결제 서버에 넘길 원본 공연 가격 및 수수료율 조회
    const event = await eventRepository.findEventById(reservation.event_id);
    const feePolicy = await eventRepository.getFeePolicy(reservation.event_id);
    const salesCommissionRate = feePolicy ? feePolicy.sales_commission_rate : 0;

    /**
     * [환불 명세서 반환]
     * 검증 통과 후 결제/관리자 서버 MQ 발행에 필요한 정보들을 규격화하여 리턴.
     */
    return {
        ticketCode: ticketCode,
        memberId: Number(memberId),
        totalPrice: reservation.total_price, 
        quantity: reservation.ticket_count, // 🚩 Java 결제 규격에 맞게 quantity로 명명
        artistId: event ? event.artist_id : null,
        ticketPrice: event ? event.price : 0,
        salesCommissionRate: salesCommissionRate,
        eventTitle: event ? event.title : "환불 요청"
    };
};

/**
 * =========================================================================
 * [관리자 환불 승인 대기 처리] (prepareRefundAdminRequest)
 * =========================================================================
 * 목적: 사용자가 환불 요청 시 즉시 취소하지 않고, 관리자 승인 대기 상태(PENDING)로 
 * DB에 기록한 후 큐(Queue) 전송용 데이터를 구성함.
 * 커넥션 풀 누수를 막기 위해 new PrismaClient()를 제거하고 전용 Repository 함수를 사용.
 * -------------------------------------------------------------------------
 */
exports.prepareRefundAdminRequest = async (ticketCode, memberId, refundReason) => {
    // 1. 기존 processRefund 함수를 재활용하여 자격/보안 검증 및 기본 데이터 로드
    const refundPayload = await this.processRefund(ticketCode, memberId);

    // 2. 예약 데이터 조회 (트랜잭션에 필요한 reservation_id 추출용)
    const reservation = await resRepository.findReservationByCode(ticketCode);
    if (!reservation) throw { status: 404, message: "예매 내역을 찾을 수 없습니다." };

    try {
        /**
         * 3. [DB 트랜잭션] 환불 테이블 기록 & 예약 상태 업데이트
         * 모든 DB 접근은 Repository 패턴 규칙에 따라 resRepository에 위임하여 처리함.
         * (reservation_refunds에 PENDING 기록 삽입 + 기존 예약을 REFUND_PENDING으로 변경)
         */
        const refundRecord = await resRepository.createRefundAdminRequest(
            reservation.reservation_id,
            memberId,
            refundPayload.totalPrice,
            refundReason
        );

        console.log(`✅ [환불 요청 DB 저장] RefundID: ${refundRecord.refund_id}, 상태: PENDING`);

        // 4. 컨트롤러가 RabbitMQ로 쉽게 전송할 수 있도록 환불 ID를 합쳐서 반환
        return {
            ...refundPayload, 
            refund_id: refundRecord.refund_id
        };

    } catch (error) {
        console.error("❌ 환불 DB 저장 중 오류 발생:", error);
        throw { status: 500, message: "환불 요청을 처리하는 중 서버 오류가 발생했습니다." };
    }
};

/**
 * =========================================================================
 * [마이페이지 조회 서비스] 내 예매 내역 가져오기 (getMyReservations)
 * =========================================================================
 * 목적: 유저 대시보드에서 본인이 예매한 전체 목록과 포스터 정보를 보여주기 위해 사용됨.
 * -------------------------------------------------------------------------
 */
exports.getMyReservations = async (memberId) => {
    // Repository에서 조인(Join)된 다중 테이블 데이터를 가져옴
    const reservations = await resRepository.findReservationsByMemberId(memberId);

    // 프론트엔드 UI 컴포넌트 구조에 맞게 복잡한 객체 그래프를 평탄화(Mapping)
    return reservations.map(res => ({
        reservation_id: res.reservation_id, 
        ticket_code: res.ticket_code,
        status: res.status,
        ticket_count: res.ticket_count,
        pure_price: res.total_price - res.booking_fee, // 수수료 제외 순수 금액
        // 스냅샷에 있던 좌석 정보도 필요하면 포함
        selected_seats: res.selected_seats, 
        events: {
            title: res.events.title,
            artist_name: res.events.artist_name, 
            event_date: res.events.event_date,
            // b.events.event_locations.venue 경로 대응
            event_locations: {
                venue: res.events.event_locations?.venue || "장소 정보 없음"
            },
            poster: res.events.event_images[0]?.image_url || null
        },
        booked_at: res.booked_at
    }));
};

/**
 * =========================================================================
 * [아티스트 전용] 특정 이벤트 예매자 명단 조회 (getAttendesByEventId)
 * =========================================================================
 * 목적: 아티스트가 자신의 공연에 누가 예매했는지 확인하고 엑셀로 다운로드할 수 있게 가공함.
 * -------------------------------------------------------------------------
 */
exports.getAttendesByEventId = async (eventId) => {
    // 1. DB 조회는 Repository에게 위임
    const reservations = await resRepository.findReservationsByEventId(eventId);
    
    // 2. 비즈니스 로직: 프론트엔드가 테이블이나 엑셀로 만들기 편하도록 데이터 구조 평탄화
    return reservations.map(res => ({
        reserveId: res.reservation_id,
        // BigInt 타입은 JSON 직렬화 시 에러가 나므로 toString()으로 안전하게 변환
        memberId: res.member_id.toString(), 
        // MSA 구조상 예매 DB에는 이름/번호가 없으므로 임시 값 매핑 (필요시 User 서비스 통신 필요)
        name: `회원 ${res.member_id.toString()}`, 
        phone: '번호 확인 불가', 
        status: res.status,
        date: res.booked_at ? res.booked_at.toISOString().split('T')[0] : '날짜 없음',
        ticketCount: res.ticket_count
    }));
}

/**
 * =========================================================================
 * [아티스트 대시보드] 예매 통계 데이터 가공 (getTicketStats)
 * =========================================================================
 * 목적: 아티스트 페이지에 '최근 5일간 티켓 판매 추이' 차트를 그리기 위한 데이터 가공.
 * 특징: 예매가 없는 날(0매)도 차트에 표시되도록 빈 날짜를 채워주는 로직이 포함됨.
 * -------------------------------------------------------------------------
 */
exports.getTicketStats = async (artistId) => {
  // 1. 기준일 계산 (오늘 포함 5일 전 자정 시간 세팅)
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 4);
  startDate.setHours(0, 0, 0, 0);

  // 2. DB에서 최근 5일 데이터 한 번에 조회
  const rawData = await resRepository.getRecentReservationsByArtist(artistId, startDate);

  // 3. 최근 5일 날짜 맵 초기화 (예: {'03.14': 0, '03.15': 0, ...}) - 빈 날짜 메우기 용도
  const statsMap = {};
  for (let i = 4; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    statsMap[mmdd] = 0;
  }

  // 4. 조회된 데이터로 티켓 수량 누적
  rawData.forEach(row => {
    const d = new Date(row.booked_at);
    const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    if (statsMap[mmdd] !== undefined) {
      statsMap[mmdd] += row.ticket_count;
    }
  });

  // 5. 프론트엔드 차트 컴포넌트가 인식할 수 있는 배열 형태로 변환해서 리턴
  return Object.keys(statsMap).map(date => ({
    date,
    count: statsMap[date]
  }));
};

/**
 * =========================================================================
 * [상태 폴링] 티켓 코드로 예약 상태 실시간 조회 (checkStatus)
 * =========================================================================
 * 목적: 프론트엔드의 폴링(Polling) API 요청에 대응하여 특정 결제의 성공/실패 여부를 반환함.
 * 컨트롤러에서 터지던 prisma 에러를 방지하고자 Repository 전용 함수(getStatusByTicketCode)를 호출.
 * -------------------------------------------------------------------------
 */
exports.checkStatus = async (ticketCode) => {
    try {
        const reservation = await resRepository.getStatusByTicketCode(ticketCode);

        if (!reservation) {
            return 'NOT_FOUND';
        }

        return reservation.status; // PENDING, CONFIRMED, FAILED 등 현재 상태 반환
    } catch (error) {
        console.error("[resService.checkStatus] Error:", error);
        throw error;
    }
};

/**
 * =========================================================================
 * [어드민 전용] 환불 대기 리스트 전체 조회 (getPendingRefunds)
 * =========================================================================
 * 목적: 관리자가 환불 승인 처리를 하기 위해 띄우는 목록(PENDING 상태) 데이터 제공
 * -------------------------------------------------------------------------
 */
exports.getPendingRefunds = async () => {
    // 1. DB 조인 쿼리를 통해 환불 데이터와 원본 예약 데이터를 함께 가져옴
    const refunds = await resRepository.findPendingRefunds();

    // 2. 프론트엔드 AdminRefund.jsx 컴포넌트 구조에 딱 맞게 이름 매핑
    return refunds.map(item => ({
        refundId: item.refund_id,
        // reservations 테이블의 ticket_code를 targetId로 통일
        targetId: item.reservations.ticket_code, 
        // BigInt 데이터가 화면에서 깨지는 것을 막기 위한 문자열 변환 처리
        memberId: item.member_id.toString(),    
        totalPrice: item.refund_amount,         
        title: item.reservations.events.title,  
        reason: item.refund_reason,             
        status: item.status,
        createdAt: item.created_at
    }));
};

/**
 * =========================================================================
 * [어드민 전용] 환불 완료 내역 전체 조회 (getCompletedRefunds)
 * =========================================================================
 * 목적: 이미 처리(REFUNDED)된 환불 내역의 히스토리를 대시보드에 뿌리기 위해 가공.
 * -------------------------------------------------------------------------
 */
exports.getCompletedRefunds = async () => {
    const reservations = await resRepository.findCompletedRefunds();

    return reservations.map(item => {
        // 가장 최근에 실행된 환불 레코드(사유 및 처리일시) 추출
        const refund = item.reservation_refunds[0]; 
        
        return {
            refundId:    refund?.refund_id || null,
            targetId:    item.ticket_code,           // reservations에서 직접 추출
            memberId:    item.member_id.toString(),  // 직렬화 에러 방지
            totalPrice:  refund?.refund_amount || item.total_price,
            title:       item.events.title,          // 이벤트 이름
            reason:      refund?.refund_reason || null,
            status:      item.status,
            processedAt: refund?.processed_at || null,
            createdAt:   item.booked_at
        };
    });
};

// =========================================================================
// [아티스트 이벤트] 
// =========================================================================
// [핵심] 최근 5일 예매(티켓 구매량) 추이 조회 
exports.getDailySalesTrend = async (artistId) => {
    try {
        // 1. 최근 5일 날짜 뼈대 생성 (티켓이 안 팔린 0건인 날짜도 차트에 그려야 하니까)
        const last5Days = [];
        const today = new Date();

        for (let i = 4; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            
            // MM/DD 포맷 (예: '03/25')
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            
            last5Days.push({
                date: `${month}/${day}`,
                count: 0,
                // 검색 시작/종료 범위 세팅
                startOfDay: new Date(d.setHours(0, 0, 0, 0)),
                endOfDay: new Date(d.setHours(23, 59, 59, 999))
            });
        }

        const startDate = last5Days[0].startOfDay;

        // 2. DB 조회: 해당 아티스트의 이벤트에 대한 최근 5일 예매 내역 가져오기
        const reservations = await prisma.reservations.findMany({
            where: {
                events: {
                    artist_id: BigInt(artistId) // BigInt 타입 캐스팅 필수
                },
                booked_at: {
                    gte: startDate // 최근 5일 시작점 이후
                },
                status: 'CONFIRMED' // 확정된 예매만 카운트 (DB 스키마에 맞춰 수정 가능)
            },
            select: {
                booked_at: true,
                ticket_count: true // 단순 예매 횟수가 아니라 '실제 구매한 티켓 장수' 기준
            }
        });

        // 3. 날짜별로 티켓 구매량 합산
        reservations.forEach(res => {
            if (!res.booked_at) return;

            const d = new Date(res.booked_at);
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const formattedDate = `${month}/${day}`;

            // 뼈대 배열에서 날짜 찾아서 구매 장수(ticket_count) 더하기
            const targetDay = last5Days.find(item => item.date === formattedDate);
            if (targetDay) {
                targetDay.count += res.ticket_count; 
            }
        });

        // 4. 불필요한 Date 객체(startOfDay 등) 빼고 프론트로 보낼 알맹이만 리턴
        return last5Days.map(item => ({
            date: item.date,
            count: item.count
        }));

    } catch (error) {
        console.error("❌ 예매 추이 조회 에러:", error);
        throw error;
    }
};
