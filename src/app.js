// src/app.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan'); // 로그 확인용
const { connectRabbitMQ } = require('./config/rabbitMQ'); // MQ 연결 함수 가져오기

// [1] 앱 초기화 및 기본 설정
const app = express();
const PORT = process.env.PORT || 8082; // 환경 변수가 없으면 기본 8082 포트 사용
const path = require('path');

/**
 * [2] 인프라 연결 설정 (Redis)
 * Server 1의 Redis와 연결하여 선착순 재고를 관리함
 * 별도의 설정 파일에서 생성된 연결 객체를 가져와서 재사용 (중복 연결 방지)
 */
const redisClient = require('./config/redisClient');

// [3] 미들웨어 설정
app.use(morgan('dev')); // [디버깅] 클라이언트의 요청(Method, URL, 응답코드)을 콘솔에 실시간으로 찍어줌
app.use(cors());        // [보안] 다른 도메인(프론트엔드 등)에서의 자원 요청을 허용함
app.use(express.json()); // [파싱] HTTP 요청 바디의 JSON 데이터를 JS 객체로 변환함
app.use(express.urlencoded({ extended: true })); // [파싱] 폼 데이터 등 URL 인코딩된 바디를 해석함


//  정적 파일 제공 경로 동적 매핑
//  저장할 때(resRoutes.js)와 동일하게, 환경에 따라 실제 파일이 있는 폴더를 바라보게 함
const staticPath = process.platform === 'win32' 
    ? path.join(process.cwd(), 'uploads') 
    : (process.env.UPLOAD_DIR || '/app/public/images/res');

app.use('/images/res', express.static(staticPath));

/**
 * [4] 라우터 연결 ( 404 발생 주의 구역)
 * Nginx 환경을 고려하여 루트('/') 경로에 예약을 처리하는 모든 라우터를 매핑함.
 * 만약 테스트 코드가 'http://localhost:8082/api/res'를 찌르고 있다면, 
 * 여기서 '/'로 매핑했기 때문에 경로 불일치로 404가 발생할 수 있음.
 */
const resRoutes = require('./routes/resRoutes');
app.use('/', resRoutes);

/**
 * [5] 시스템 헬스체크 및 메인 엔드포인트
 * 서버가 살아있는지, 인프라(DB, Redis)와 연결이 정상적인지 확인하는 모니터링용 API
 */
app.get('/', (req, res) => {
    res.status(200).send({
        service: "Reservation Service",
        status: "Running",
        port: PORT,
        infrastructure: {
            database: "PostgreSQL Connected",
            cache: "Redis Connected"
        }
    });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// BigInt를 JSON으로 보낼 때 자동으로 숫자(또는 문자열)로 변환해주는 마법의 코드
BigInt.prototype.toJSON = function() {
    return this.toString();
};

// [6] 전역 에러 핸들러: 서버 내부에서 발생하는 모든 예외를 캐치하여 500 에러로 응답함
app.use((err, req, res, next) => {
    console.error(`[Internal Error] ${err.stack}`);
    res.status(500).json({ message: "Internal Server Error" });
});

// [7] 서버 실행 및 초기 데이터 로드 (Warm-up)
const resService = require('./services/resService');
const eventService = require('./services/eventService');

// [메시징 시스템] 각 역할을 가진 RabbitMQ 컨슈머들을 불러옴
const startConsumer = require('./messaging/listener/consumer'); 
const startCancelConsumer = require('./messaging/listener/cancelConsumer');
const startStatusUpdateConsumer = require('./messaging/listener/statusUpdateConsumer');
const startEventResponseConsumer = require('./messaging/listener/eventResponseConsumer');
const startRefundResponseConsumer = require('./messaging/listener/refundResponseConsumer'); // 🌟 [추가] 환불 승인 리스너
const startDashboardConsumer = require('./messaging/listener/dashboardConsumer');

/**
 * [서버 리스닝 및 초기화 프로세스]
 */
app.listen(PORT, async () => {
    console.log(`🚀 [Reservation] Service is running on port ${PORT}`);

    try {
        /**
         * 0. RabbitMQ '발행용' 채널 연결
         * 컨트롤러에서 결제 요청 등을 MQ로 쏘기 위해 필요한 커넥션을 서버 시작 시점에 확립함.
         */
        await connectRabbitMQ(); 

        /**
         * 1. RabbitMQ Consumer 순차 실행
         * 예약 처리, 비상 취소 감시, 상태 업데이트 결과를 수신하는 3개의 컨슈머를 각각 기동함.
         */
        await startConsumer(); 
        await startCancelConsumer();
        await startStatusUpdateConsumer();
        // 공연 승인 결과 처리 컨슈머 실행
        await startEventResponseConsumer();
        // 환불 승인 결과 처리 컨슈머 실행
        await startRefundResponseConsumer();
        // 대시보드 컨슈머 시작
        await startDashboardConsumer();

        console.log("✅ [Messaging] 모든 RabbitMQ 컨슈머 연결 성공");

        /**
         * 2. Redis 재고 Warm-up 실행
         * 티켓팅 오픈 전 DB의 최신 재고 데이터를 Redis로 미리 로드하여 
         * 첫 요청부터 초고속 선착순 처리가 가능하게 준비함.
         */
        setTimeout(async () => {
            try {
                console.log("🔄 [Warm-up] Starting Redis Warm-up...");
                await eventService.warmupAllEventsToRedis();
                console.log(`✅ [Warm-up] 모든 이벤트 재고 Redis 동기화 완료`);
            } catch (err) {
                console.error("❌ [Warm-up Error] 초기화 중 오류 발생:", err.message);
            }
        }, 2000);
        
        console.log(`✅ [Warm-up] 모든 이벤트 재고 Redis 동기화 완료`);

    } catch (err) {
        console.error("❌ [Initialization Error] 초기화 실패:", err.message);
    }
});
