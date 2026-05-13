// src/controllers/eventController.js

const prisma = require('../config/prisma');
const eventService = require('../services/eventService');
const resService = require('../services/resService'); // warmup 등을 위해 필요
const eventRepository = require('../repositories/eventRepository'); // 이벤트 목록 조회용
const redis = require('../config/redisClient'); // 🚀 Redis 클라이언트 필수!
const mq = require('../config/rabbitMQ');
const { SCALE_POLICIES, INTERNAL_VENUE_POLICY, INTERNAL_VENUES } = require('../constants/policy');

// =========================================================================
// [1] 유저용: 전체 공연 목록 조회 (getAllEvents)
// =========================================================================
// 목적: 메인 페이지 진입 시 노출할 전체 공연/티켓 리스트를 반환함.
exports.getAllEvents = async (req, res) => {
    try {
        const events = await eventRepository.findAllEvents(); // 레포지토리 이름 유지
        
        // 여기서 serializeBigInt 사용!
        // Prisma가 반환하는 DB의 BigInt 타입 데이터가 JSON으로 파싱될 때 터지는 에러를 방지
        res.status(200).json({ 
            events: serializeBigInt(events) 
        });
    } catch (err) {
        console.error("❌ 유저 이벤트 조회 오류:", err);
        res.status(500).json({ message: "공연 목록 로드 실패" });
    }
};

// =========================================================================
// [2] 아티스트용: 내 공연 목록 조회 (getMyEvents)
// =========================================================================
// 목적: 아티스트가 자신의 대시보드에서 본인이 올린 공연들과 예매된 좌석 현황을 확인할 때 사용.
exports.getMyEvents = async (req, res) => {
    try {
        // 🌟 헤더 대신 쿼리에서 바로 artistId 추출!
        const artistId = req.query.artistId;
        
        if (!artistId) return res.status(400).json({ message: "artistId가 없습니다." });

        const events = await eventRepository.findArtistEvents(artistId);
        
        // 프론트엔드 좌석 UI(Grid)에서 사용하기 편하도록 데이터 평탄화 작업 수행
        const formattedEvents = events.map(event => {
            // selected_seats가 "A1, A2" 문자열일 테니까 배열로 쪼개기
            const reservedSeats = (event.reservations || []).flatMap(res => {
                if (typeof res.selected_seats === 'string') {
                    return res.selected_seats.split(',').map(s => s.trim());
                }
                return res.selected_seats || [];
            });

            return {
                ...event,
                reservedSeats: reservedSeats // 프론트 좌석표에서 쓸 데이터
            };
        });

        res.status(200).json({ 
            events: serializeBigInt(formattedEvents) 
        });
    } catch (err) {
        console.error("❌ 조회 오류:", err.message);
        res.status(500).json({ message: "서버 오류 발생" });
    }
};

/**
 * =========================================================================
 * BigInt 변환 유틸 (절대 삭제 금지)
 * =========================================================================
 * JSON.stringify가 처리 못하는 BigInt를 문자열로 바꿔줌. 
 * 이거 없으면 Type Error 나면서 서버 응답이 터짐.
 */
const serializeBigInt = (data) => {
    return JSON.parse(JSON.stringify(data, (k, v) => 
        typeof v === 'bigint' ? v.toString() : v
    ));
};

/**
 * =========================================================================
 * [2] 특정 이벤트 상세 정보 조회 (getEventDetail)
 * =========================================================================
 * 목적: 공연 상세 페이지 진입 시 기본 정보, 남은 좌석 배열, 찜(Wishlist) 여부를 한 번에 조회.
 */
exports.getEventDetail = async (req, res) => {
    try {
        const { eventId } = req.params;
        const { memberId } = req.query; // 프론트에서 보낸 ?memberId=1
        const parsedEventId = parseInt(eventId, 10);

        // 1. Prisma 조회 시 include를 조건부로 처리 (동적 쿼리 조립)
        const includeOptions = {
            event_locations: true,
        };

        // 중요: memberId가 있을 때만 위시리스트 포함 (false를 넣으면 에러 남!)
        if (memberId && memberId !== 'undefined' && memberId !== 'null') {
            includeOptions.event_wishlists = {
                where: { member_id: BigInt(memberId) }
            };
        }

        const event = await prisma.events.findUnique({
            where: { event_id: parsedEventId },
            include: includeOptions
        });
        
        if (!event) return res.status(404).json({ message: "공연을 찾을 수 없습니다." });

        // 2. 예약된 좌석 목록 가져오기 (기존 로직 유지)
        // 결제 실패나 환불된 내역을 제외한 진짜 '예매 완료' 좌석들만 뽑아냄
        const reservations = await prisma.reservations.findMany({
            where: {
                event_id: parsedEventId,
                status: { notIn: ['FAILED', 'REFUNDED'] },
                selected_seats: { not: null }
            },
            select: { selected_seats: true }
        });

        let reservedSeatsList = [];
        reservations.forEach(r => {
            if (Array.isArray(r.selected_seats)) {
                reservedSeatsList.push(...r.selected_seats);
            }
        });

        // 3. 찜 여부 판단 (조인된 결과물이 있으면 true)
        const isWishlisted = !!(event.event_wishlists && event.event_wishlists.length > 0);
        
        // 4. BigInt 포함된 객체를 안전하게 변환 (500 에러 방지 핵심)
        const responseData = JSON.parse(JSON.stringify({
            ...event,
            isWishlisted,
            reservedSeats: reservedSeatsList
        }, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));

        res.json(responseData);

    } catch (error) {
        // 서버 로그에서 진짜 원인을 볼 수 있게 출력
        console.error("❌ 상세 조회 서버 오류:", error); 
        res.status(500).json({ message: "상세 조회 중 오류 발생", error: error.message });
    }
};

/**
 * =========================================================================
 * [3] 공연의 지도 정보(장소, 주소) 조회 및 좌표 보정 (getEventLocation)
 * =========================================================================
 * 목적: 프론트 상세 페이지 하단에 카카오/네이버 지도를 그리기 위한 위경도 반환.
 * 특징: DB에 좌표가 없으면 API로 긁어와서 채워넣는 Self-healing(자가 치유) 로직 포함.
 */
exports.getEventLocation = async (req, res) => {
    const { eventId } = req.params;
    try {
        /**
         * [관계형 데이터 로드]
         * findUnique 조회 시 'include'를 사용하여 공연 정보뿐만 아니라 자식 테이블인 'event_locations' 데이터까지 함께 가져옴 (Eager Loading)
         */
        const event = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) },
            include: { event_locations: true }
        });

        // [유효성 검사] 공연 데이터가 없거나, 연결된 위치 데이터가 테이블에 존재하지 않는 경우를 걸러냄
        if (!event || !event.event_locations) {
            return res.status(404).json({ message: "해당 공연 정보를 찾을 수 없어." });
        }

        // [참조 할당] 가독성을 위해 위치 정보 객체를 loc 변수에 따로 담아둠
        let loc = event.event_locations;

        /**
         * [좌표 유무 확인]
         * DB에 저장된 위도(latitude)나 경도(longitude) 값이 비어있는지 체크함
         */
        if (!loc.latitude || !loc.longitude) {
            // [외부 API 호출] 좌표가 없다면 eventService의 카카오 지오코딩 로직을 실행하여 주소를 좌표 숫자로 변환함
            const coords = await eventService.getCoordinates(loc.address);
            
            // [DB 실시간 보정] 카카오 API로부터 좌표를 받아오는 데 성공했다면
            if (coords) {
                // [Self-healing] 다음 조회 시 API 호출을 하지 않도록 획득한 좌표를 DB에 즉시 기록하여 보존함
                loc = await prisma.event_locations.update({
                    where: { event_id: loc.event_id },
                    data: { latitude: coords.lat, longitude: coords.lng }
                });
            }
        }

        // [최종 데이터 가공] 클라이언트 지도 라이브러리가 즉시 사용할 수 있도록 정제된 포맷으로 반환함
        res.json({
            title: event.title,
            venue: loc.venue,
            address: loc.address,
            lat: loc.latitude,
            lng: loc.longitude
        });
    } catch (error) {
        console.error("❌ 지도 정보 조회 중 오류:", error.message);
        res.status(500).json({ message: "서버 내부 오류 발생" });
    }
};

/**
 * =========================================================================
 * [날짜 포맷 변환 유틸] (formatToSpring)
 * =========================================================================
 * Java Spring의 LocalDateTime 형식이 인식할 수 있도록 ISO 표준(T 포함)으로 변환
 * (MSA 환경에서 Node.js -> Java 로 데이터 넘길 때 필수적인 포맷팅)
 */
const formatToSpring = (dateInput) => {
    const d = new Date(dateInput);
    const pad = (n) => n < 10 ? '0' + n : n;
    
    // 날짜와 시간 사이에 'T'를 명시적으로 넣어줌
    return d.getFullYear() + '-' +
           pad(d.getMonth() + 1) + '-' +
           pad(d.getDate()) + 'T' +  // 👈 여기가 핵심! 공백 대신 'T'
           pad(d.getHours()) + ':' +
           pad(d.getMinutes()) + ':' +
           pad(d.getSeconds());
};

/**
 * =========================================================================
 * [4] 공연 등록 신청 (이미지 저장 + 신규 필드 반영) (requestEventApproval)
 * =========================================================================
 * 목적: 아티스트가 신규 공연을 열고 싶을 때 관리자에게 승인을 요청하는 복합 API.
 * 흐름: 폼 데이터/이미지 파싱 -> 정책 산출 -> 다중 DB Insert (트랜잭션) -> MQ로 관리자 서버에 큐 발송
 */
exports.requestEventApproval = async (req, res) => {
    // 1. 데이터 추출 (신규 필드 추가: age_limit, running_time, is_standing, seat_map_config)
    let { 
        requester_id, member_id, 
        title, total_capacity, price, description, venue, address, 
        event_date, open_time, close_time, 
        images, // 👈 ["url1", "url2"] 형태의 배열
        artist_id, artist_name, event_type,
        age_limit, running_time, is_standing, seat_map_config 
    } = req.body;

    try {
        console.log("--- 🚀 컨트롤러 요청 도착 ---");

        // Multer로 업로드된 실제 파일이 있다면 images 배열 맨 앞에 추가
        // 메인 포스터로 띄우기 위해 무조건 맨 앞(인덱스 0)으로 밀어넣음.
        if (req.file) {
            const uploadedFilename = req.file.filename;
            if (!images) images = [];
            if (!Array.isArray(images)) images = [images]; // 문자열로 왔을 경우 대비
            // 실제 파일을 포스터(1순위)로 쓰기 위해 맨 앞에 넣음
            images.unshift(uploadedFilename); 
        }

        const finalRequesterId = requester_id || member_id;
        const finalArtistId = artist_id || finalRequesterId;

        if (!finalRequesterId) throw new Error("requester_id(또는 member_id)가 누락되었습니다.");

        // 주소를 좌표로 변환
        const coords = await eventService.getCoordinates(address);
        const lat = coords ? coords.lat : null;
        const lng = coords ? coords.lng : null;

        /**
         * [신규 로직] 수수료 및 정산 정책 자동 계산
         * 공연장 종류나 관객 규모에 따라 시스템이 자동으로 수수료(%)를 판별함.
         */
        const parsedCapacity = parseInt(total_capacity, 10) || 0;
        let appliedPolicy;
        
        if (INTERNAL_VENUES.includes(venue)) {
            appliedPolicy = INTERNAL_VENUE_POLICY; 
        } else {
            appliedPolicy = SCALE_POLICIES.find(p => parsedCapacity >= p.min) || SCALE_POLICIES[2];
        }

        // 관리자 확인용 스냅샷 (신규 필드 포함) - 나중에 관리자가 뭘 컨펌했는지 히스토리를 남기기 위함
        const eventSnapshot = {
            title, artist_id, artist_name, event_type, description,
            price: parseInt(price, 10) || 0,
            total_capacity: parsedCapacity,
            venue, address, event_date, open_time, close_time,
            age_limit: parseInt(age_limit, 10) || 0,
            running_time: parseInt(running_time, 10) || 0,
            is_standing: is_standing === true || is_standing === 'true',
            seat_map_config: seat_map_config || null,
            images: images || [],
            sales_commission_rate: appliedPolicy.rate,
            settlement_type: appliedPolicy.type
        };

        /**
         * 2. 트랜잭션 처리
         * 데이터 무결성을 위해 4개의 연관 테이블을 한 번의 쿼리 사이클로 안전하게 밀어넣음.
         */
        const { newEvent, approvalReq } = await prisma.$transaction(async (tx) => {
            // (1) 공연 기본 정보 생성 (신규 필드 포함)
            const createdEvent = await tx.events.create({
                data: {
                    title: title || "제목 없음", 
                    artist_id: BigInt(finalArtistId),
                    artist_name: artist_name || "Unknown Artist", 
                    event_type: event_type || "CONCERT", 
                    description: description || "",
                    price: parseInt(price, 10) || 0,
                    total_capacity: parsedCapacity,
                    available_seats: parsedCapacity,
                    event_date: event_date ? new Date(event_date) : new Date(),
                    open_time: open_time ? new Date(open_time) : new Date(),
                    close_time: close_time ? new Date(close_time) : new Date(),
                    age_limit: parseInt(age_limit, 10) || 0,
                    running_time: parseInt(running_time, 10) || 0,
                    is_standing: is_standing === true || is_standing === 'true',
                    seat_map_config: seat_map_config || null,
                    approval_status: 'PENDING',
                }
            });

            // (2) 장소 정보 생성
            await tx.event_locations.create({
                data: {
                    event_id: createdEvent.event_id,
                    venue: venue || "장소 미정", address: address || "", latitude: lat, longitude: lng
                }
            });

            // (3) [신규] 사진 정보 생성 (Bulk Insert)
            if (images && Array.isArray(images) && images.length > 0) {
                await tx.event_images.createMany({
                    data: images.map((url, index) => ({
                        event_id: createdEvent.event_id,
                        image_url: url,
                        image_role: index === 0 ? 'POSTER' : 'DETAIL', // 첫 번째는 포스터
                        sort_order: index
                    }))
                });
            }

            // (4) 승인 요청 데이터 생성
            const createdApproval = await tx.event_approvals.create({
                data: {
                    event_id: createdEvent.event_id,
                    requester_id: BigInt(finalRequesterId),
                    status: 'PENDING',
                    event_snapshot: eventSnapshot // 스키마 필수 조건 만족!
                }
            });

            // (5) 승인 ID 업데이트
            await tx.events.update({
                where: { event_id: createdEvent.event_id },
                data: { approval_id: createdApproval.approval_id }
            });

            return { newEvent: createdEvent, approvalReq: createdApproval };
        });

        // 3. [MSA] Java DTO 조립 (신규 필드 포함하여 관리자에게 발송)
        // Java Admin 서버에서 RequestBody로 받는 DTO 스펙에 100% 맞춰서 조립함.
        const eventResultDTO = {
            approvalId: Number(newEvent.event_id), 
            requesterId: Number(finalRequesterId), 
            status: 'PENDING',
            eventTitle: title,
            rejectionReason: null,
            createdAt: formatToSpring(approvalReq.created_at || new Date()),
            eventDate: formatToSpring(event_date || new Date()),
            location: venue,
            price: Number(price) || 0,
            ageLimit: parseInt(age_limit, 10) || 0,
            runningTime: parseInt(running_time, 10) || 0,
            isStanding: is_standing === true || is_standing === 'true',
            salesCommissionRate: appliedPolicy.rate,
            settlementType: appliedPolicy.type,
            scaleGroup: appliedPolicy.group.substring(0, 1), 
            // 핵심: Nginx가 /images/res/ 경로를 감시하므로 URL도 그에 맞춰 생성
            imageUrl: (images && images.length > 0) 
                ? (images[0].startsWith('http') 
                    ? images[0] 
                    : `/images/res/${images[0]}`) // 앞에 도메인 싹 빼고 상대 경로
                : null,
            // 2. [추가] 예매 오픈/종료 시간 & 총 좌석 수 
            eventStartDate: formatToSpring(open_time || new Date()), // 예매 시작
            eventEndDate: formatToSpring(close_time || new Date()),  // 예매 종료
            totalCapacity: parsedCapacity                              // 좌석표 계산용
        };

        // RabbitMQ 전송
        await mq.publishToQueue(mq.ROUTING_KEYS.EVENT_REQ_ADMIN, eventResultDTO);

        console.log(`📤 [관리자 전송] ID: ${eventResultDTO.approvalId}, 제목: ${eventResultDTO.eventTitle}`);
        
        res.status(201).json({ 
            message: "신청 완료 및 이미지 등록 성공", 
            approvalId: eventResultDTO.approvalId,
            imageUrl: eventResultDTO.imageUrl
        });

    } catch (error) {
        console.error("❌ 승인 요청 실패:", error.message);
        res.status(500).json({ message: `신청 실패: ${error.message}` });
    }
};

/**
 * =========================================================================
 * [5] 모든 이벤트 재고 Redis 동기화 (Admin Warm-up)
 * =========================================================================
 */
exports.warmupRedis = async (req, res) => {
    try {
        /**
         * [캐시 워밍 실행]
         * 관리자가 수동으로 DB의 재고 데이터를 Redis로 밀어넣는 서비스를 호출함. 
         * 이는 서버 장애 복구 후나 대규모 이벤트 오픈 직전에 재고를 메모리에 미리 올리는 필수 작업임.
         * DB에 있는 모든 재고 정보를 Redis로 복사함 (티켓 오픈 전 필수 작업)
         */
        await resService.warmupAllEventsToRedis();
        
        // [관리자 확인 응답] 작업 완료 메시지를 200 상태코드와 함께 반환함
        res.status(200).json({ message: "모든 이벤트 재고가 Redis에 성공적으로 로드되었습니다." });
    } catch (err) {
        console.error("❌ Admin Warmup Error:", err);
        res.status(500).json({ error: err.message });
    }
};

// =========================================================================
// [대시보드] 유저 대시보드 이벤트 큐 발송 (sendDashboardQueues)
// =========================================================================
// 유저 대시보드 진입 시 전체 이벤트 및 개인 예매 내역 큐 발송
// 타 마이크로서비스(특히 Front-end 갱신 용도 등)로 이벤트 상태를 브로드캐스팅함.
exports.sendDashboardQueues = async (req, res) => {
    try {
        const events = await eventRepository.findAllEvents();

        // 🌟 mq.js에 새로 정의한 ROUTING_KEYS.DASHBOARD_ALL 사용
        await mq.publishToQueue(mq.ROUTING_KEYS.DASHBOARD_ALL, { 
            type: 'ALL_EVENTS_LIST',
            data: serializeBigInt(events),
            timestamp: new Date()
        });

        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ message: "실패" });
    }
};

// ── 위시리스트 추가 ──────────────────────────
exports.addWishlist = async (req, res) => {
    try {
        const { eventId } = req.params;
        const { memberId } = req.body;

        if (!memberId) return res.status(400).json({ message: 'memberId가 없습니다.' });

        // 중복 체크
        const existing = await prisma.event_wishlists.findFirst({
            where: {
                event_id: parseInt(eventId),
                member_id: BigInt(memberId)
            }
        });

        if (existing) return res.status(200).json({ message: '이미 찜한 공연입니다.', isWishlisted: true });

        await prisma.event_wishlists.create({
            data: {
                event_id: parseInt(eventId),
                member_id: BigInt(memberId)
            }
        });

        res.status(201).json({ message: '찜 추가 완료', isWishlisted: true });
    } catch (error) {
        console.error('❌ 위시리스트 추가 오류:', error);
        res.status(500).json({ message: '서버 오류' });
    }
};

// ── 위시리스트 삭제 ──────────────────────────
exports.removeWishlist = async (req, res) => {
    try {
        const { eventId } = req.params;
        const { memberId } = req.body;

        if (!memberId) return res.status(400).json({ message: 'memberId가 없습니다.' });

        await prisma.event_wishlists.deleteMany({
            where: {
                event_id: parseInt(eventId),
                member_id: BigInt(memberId)
            }
        });

        res.status(200).json({ message: '찜 삭제 완료', isWishlisted: false });
    } catch (error) {
        console.error('❌ 위시리스트 삭제 오류:', error);
        res.status(500).json({ message: '서버 오류' });
    }
};

// ── 내 위시리스트 목록 조회 ──────────────────
exports.getMyWishlist = async (req, res) => {
    try {
        const { memberId } = req.query;

        if (!memberId) return res.status(400).json({ message: 'memberId가 없습니다.' });

        const wishlists = await prisma.event_wishlists.findMany({
            where: { member_id: BigInt(memberId) },
            include: {
                events: {
                    include: { event_locations: true, event_images: true }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        res.status(200).json(serializeBigInt(wishlists));
    } catch (error) {
        console.error('❌ 위시리스트 조회 오류:', error);
        res.status(500).json({ message: '서버 오류' });
    }
};


// [GET] 모든 이벤트 목록 조회
exports.getEventsList = async (req, res) => {
  try {
    // 1. Prisma를 사용해 이벤트 데이터 전체 조회
    const events = await prisma.events.findMany({
      // 성능 최적화를 위해 프론트엔드 통계에 필요한 핵심 컬럼만 선택 (Select)
      select: {
        event_id: true,
        title: true,
        artist_id: true,
        approval_status: true,
        event_date: true,
      }
    });

    // 2. BigInt 직렬화 및 프론트엔드 변수명 매핑
    // Prisma의 BigInt는 JSON.stringify 시 에러가 발생하므로 toString()으로 변환 필수.
    // 프론트엔드(e.artistId)에서 쉽게 비교할 수 있도록 변수명을 카멜케이스로 하나 더 매핑해서 전달함.
    const serializedEvents = events.map((event) => {
      const artistIdStr = event.artist_id ? event.artist_id.toString() : null;
      
      return {
        ...event,
        artist_id: artistIdStr,
        artistId: artistIdStr, // 프론트엔드의 e.artistId === artist.memberId 조건 매칭용
      };
    });

    // 3. 데이터 응답
    // 프론트엔드 코드의 eventsRes.data.events 에 맞춰서 객체 형태로 감싸서 응답
    return res.status(200).json({ events: serializedEvents });

  } catch (error) {
    console.error('[getAllEvents] 이벤트 전체 목록 조회 실패:', error);
    return res.status(500).json({ message: '이벤트 목록을 가져오는 중 서버 오류가 발생했습니다.' });
  }
};
