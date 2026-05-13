/**
 * FanVerse - Event Repository Layer
 * 담당: Prisma를 이용한 공연 관련 PostgreSQL(Server 1) 데이터 제어
 */

const prisma = require('../config/prisma');

// [1] Redis Warm-up용 DB 재고 조회
exports.getEventStock = async (eventId) => {
    try {
        const targetEvent = await prisma.events.findUnique({
            where: { event_id: parseInt(eventId, 10) },
            select: { available_seats: true }
        });
        return targetEvent ? targetEvent.available_seats : 0;
    } catch (err) {
        console.error("❌ [getEventStock Error]:", err.message);
        throw err;
    }
};

// [2] 특정 공연 조회 (승인된 것만)
exports.findEventById = async (eventId) => {
    return await prisma.events.findUnique({
        where: { 
            event_id: parseInt(eventId, 10),
            approval_status: 'CONFIRMED' 
        }
    });
};

// [3] 승인된 모든 공연 목록 조회 (유저용)
exports.findAllEvents = async () => {
    return await prisma.events.findMany({ 
        where: { approval_status: 'CONFIRMED' }, // 무조건 승인된 것만
        include: {
            event_locations: true,
            event_images: true,
            reservations: {
                where: { status: 'CONFIRMED' },
                select: { ticket_count: true }
            }
        },
        orderBy: { event_date: 'asc' }
    });
};

// [4] 아티스트 본인 공연 조회 (상태 상관없음)
exports.findArtistEvents = async (artistId) => {
    return await prisma.events.findMany({ 
        where: { artist_id: BigInt(artistId) },
        include: {
            event_locations: true,
            event_images: true,
            // 반려 사유를 가져오기 위해
            event_approvals_events_approval_idToevent_approvals: {
                select: {
                    rejection_reason: true
                }
            },
            reservations: {
                where: { status: 'CONFIRMED' },
                select: { 
                    ticket_count: true, 
                    selected_seats: true
                }
            }
        },
        orderBy: { created_at: 'desc' }
    });
};

// [5] 새로운 공연 등록 (파일/URL 둘 다 대응)
exports.createEventRequest = async (data) => {
    return await prisma.$transaction(async (tx) => {
        // BigInt 안전 변환
        const artistId = (data.artist_id && data.artist_id !== "") ? BigInt(data.artist_id) : BigInt(0);
        const requesterId = (data.requester_id && data.requester_id !== "") ? BigInt(data.requester_id) : artistId;

        // 1. events 생성
        const newEvent = await tx.events.create({
            data: {
                title: data.title || "제목 없음",
                artist_id: artistId,
                artist_name: data.artist_name || "Unknown Artist",
                event_type: data.event_type || "CONCERT",
                description: data.description,
                price: parseInt(data.price, 10) || 0,
                total_capacity: parseInt(data.total_capacity, 10) || 0,
                available_seats: parseInt(data.total_capacity, 10) || 0,
                event_date: new Date(data.event_date),
                open_time: new Date(data.open_time),
                close_time: new Date(data.close_time),
                approval_status: 'PENDING'
            }
        });

        // 2. event_locations (필드명: venue)
        await tx.event_locations.create({
            data: {
                event_id: newEvent.event_id,
                venue: data.venue || "장소 미정",
                address: data.address || "",
                latitude: parseFloat(data.lat) || 0,
                longitude: parseFloat(data.lng) || 0
            }
        });

        // 3. event_images (image_role: POSTER)
        if (data.image_url) {
            await tx.event_images.create({
                data: {
                    event_id: newEvent.event_id,
                    image_url: data.image_url,
                    image_role: 'POSTER'
                }
            });
        }

        // 4. event_approvals ( 필수 Json 필드 snapshot 추가)
        await tx.event_approvals.create({
            data: {
                event_id: newEvent.event_id,
                requester_id: requesterId,
                status: 'PENDING',
                event_snapshot: { title: data.title, price: data.price, venue: data.venue } // 필수
            }
        });

        return newEvent;
    });
};

// [6] 공연 승인
exports.confirmEvent = async (tx, eventId, adminId) => {
    if (!eventId) throw new Error("eventId가 유효하지 않습니다.");

    await tx.event_approvals.updateMany({
        where: { event_id: Number(eventId) },
        data: { 
            status: 'CONFIRMED', 
            // [방어 코드] admin_id가 undefined/null인 경우 BigInt 에러 방지
            admin_id: (adminId !== undefined && adminId !== null) ? BigInt(adminId) : null,
            processed_at: new Date()
        }
    });

    return await tx.events.update({
        where: { event_id: Number(eventId) },
        data: { approval_status: 'CONFIRMED' }
    });
};

// [7] 공연 반려
exports.rejectEvent = async (tx, eventId, adminId, reason) => {
    if (!eventId) throw new Error("eventId가 유효하지 않습니다.");

    await tx.event_approvals.updateMany({
        where: { event_id: Number(eventId) },
        data: { 
            status: 'FAILED', 
            rejection_reason: reason,
            // [방어 코드] admin_id 안전하게 처리
            admin_id: (adminId !== undefined && adminId !== null) ? BigInt(adminId) : null,
            processed_at: new Date()
        }
    });

    return await tx.events.update({
        where: { event_id: Number(eventId) },
        data: { approval_status: 'FAILED' }
    });
};

// [8] 정산 정책 조회
exports.getFeePolicy = async (eventId) => {
    return await prisma.event_fee_policies.findUnique({
        where: { event_id: parseInt(eventId, 10) }
    });
};

// [9] 유저 대시보드 [내 예매 내역 조회]
exports.findConfirmedReservationsByUserId = async (userId) => {
    return await prisma.reservations.findMany({
        where: {
            user_id: BigInt(userId),
            status: 'CONFIRMED'
        },
        include: {
            events: {
                include: { event_locations: true }
            }
        }
    });
};
