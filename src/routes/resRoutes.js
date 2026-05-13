// src/routes/resRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const resController = require('../controllers/resController');
const eventController = require('../controllers/eventController');
const testController = require('../controllers/testController');

// [파일 저장 설정]
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // 리눅스(도커) 환경에서는 외부 볼륨과 연결된 컨테이너 내부 경로(/app/public/images/res)를 사용
        const dir = process.platform === 'win32' 
            ? path.join(process.cwd(), 'uploads') // 윈도우: 로컬 개발용
            : (process.env.UPLOAD_DIR || '/app/public/images/res'); // 리눅스(도커): 환경변수 우선, 없으면 기본 볼륨 경로

        // 폴더가 없으면 자동으로 만든다
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });



// [GET] 이벤트 전체 목록 조회
router.get('/events', eventController.getAllEvents); // 👈 eventController로 변경

// [GET] 아티스트용: 본인이 신청한 공연 목록 조회 (Private/Management)
// 예: /msa/res/events/my?artistId=1
router.get('/events/my', eventController.getMyEvents);

// [GET] 특정 이벤트 상세 정보 조회 (Booking Process 진입 시 필요할 수 있음)
// 예: http://localhost:8082/events/:eventId
router.get('/events/:eventId', eventController.getEventDetail);

// [GET] 유저아티스트페이지 이벤트 카운트
router.get('/eventsList', eventController.getEventsList);

// 위시리스트
router.get('/wishlist', eventController.getMyWishlist);
router.post('/events/:eventId/wishlist', eventController.addWishlist);
router.delete('/events/:eventId/wishlist', eventController.removeWishlist);

// [POST] 유저대시보드 
router.post('/dashboard/dashboard-queue', eventController.sendDashboardQueues);

// [GET] 공연 정보/지도 관련
router.get('/events/:eventId/location', eventController.getEventLocation);

// [POST] 새로운 공연 등록 (Redis 동기화 로직 포함된 버전)
// 프런트엔드에서 보낸 'file' 필드를 해석하여 지정된 경로에 저장
router.post('/events', upload.single('file'), eventController.requestEventApproval);


// [POST] 예약 생성 및 처리 (UserBookingProcess에서 최종 클릭 시 호출)
router.post('/reserve', resController.createReservation);

// [GET] 특정 유저의 예약 상태 확인 (프론트엔드 폴링 주소와 일치시킴)
// /reserve/status/:userId 를 아래와 같이 변경
router.get('/reservations/status/:ticketCode', resController.getReservationStatus);

// [POST] 사용자 직접 환불 요청
router.post('/refund', resController.requestRefund);

// [POST] 사용자 직접 환불 요청
router.post('/refundList', resController.refundList);

// [POST] 어드민 환불 완료 내역 조회
router.post('/refundCompletedList', resController.refundCompletedList);

// [GET] 특정 유저의 전체 예약 내역 조회 
// 경로: /msa/res/member/:memberId
router.get('/member/:memberId', resController.getMyReservations);

// [GET] 특정 유저의 예약 상태 확인 (선택 사항)
router.get('/reserve/status/:userId', resController.getReservationStatus);

// [GET] 특정 이벤트의 예매자 명단 조회 (아티스트 엑셀 다운로드용)
router.get('/events/:eventId/reservations', resController.getEventReservations);

// [GET] 아티스트 계정에서 조회되는 본인 이벤트 최근 5일 예매조회
router.get('/artistreserve/:memberId', resController.getRecentTicketStats);

// [GET] 유저 확정 예매 건수만 조회
router.get('/dashboard/reservation-count', resController.getConfirmedReservationCount);

// [GET] [관리자 이벤트] 예매가 완료된 좌석 내역 
router.get('/reserveSeat/:eventId', resController.getEventReservedSeats);

// [GET] [아티스트 이벤트]  최근 5일 예매(티켓 구매량) 추이
router.get('/my/daily-sales', resController.getDailySalesTrend);


// [GET] test
router.get('/test', testController.handleTestRequest);

/**
 * [POST] 모든 이벤트 재고 Redis 동기화 (관리자용 Warm-up)
 * 💡 수정: 라우터에서 Service를 직접 require하지 말고 Controller에 함수를 하나 만들어서 연결해.
 */
router.post('/admin/warmup', eventController.warmupRedis); // 👈 eventController로 변경



module.exports = router;
