const amqp = require('amqplib');
require('dotenv').config();

let connection = null; 
let channel = null;    
 
// Java 서버(Admin) 상수와 100% 일치
const QUEUES = {
    RESERVATION: 'reservation.queue',
    STATUS_UPDATE: 'res.status.update.queue',
    CANCEL: 'reservation.cancel.queue',
    PAY_REQUEST: 'pay.request.queue',
    
    // 이벤트 관련
    EVENT_REQ_ADMIN: 'admin.event.queue', 
    EVENT_RES_CORE: 'event.res.core.queue',

    // 환불 관련 (Java 규격 일치)
    REFUND_REQ_ADMIN: 'refund.req.core.queue', 
    REFUND_RES_CORE: 'refund.res.core.queue',

    DASHBOARD_ALL: 'dashboard.all.queue'
};

const ROUTING_KEYS = {
    PAY_REQUEST: 'pay.request',
    STATUS_UPDATE: 'res.status.update',
    
    // 이벤트 관련
    EVENT_REQ_ADMIN:'admin.event.request',
    EVENT_RES_CORE: 'event.res.core',

    // 환불 관련 (Java 규격 일치)
    REFUND_REQ_ADMIN: 'refund.req.core', 
    REFUND_RES_CORE: 'refund.res.core',

    DASHBOARD_ALL: 'dashboard.all'
};

const EXCHANGE = 'msa.direct.exchange';

const connectRabbitMQ = async () => {
    try {
        const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

        connection = await amqp.connect(rabbitUrl);
        channel = await connection.createConfirmChannel(); 
        await channel.assertExchange(EXCHANGE, 'direct', { durable: true });

        // --- 큐 바인딩 (이거 없으면 메시지 길 잃음) ---
        
        // 1. 이벤트 요청/응답
        await channel.assertQueue(QUEUES.EVENT_REQ_ADMIN, { durable: true });
        await channel.bindQueue(QUEUES.EVENT_REQ_ADMIN, EXCHANGE, ROUTING_KEYS.EVENT_REQ_ADMIN);
        await channel.assertQueue(QUEUES.EVENT_RES_CORE, { durable: true });
        await channel.bindQueue(QUEUES.EVENT_RES_CORE, EXCHANGE, ROUTING_KEYS.EVENT_RES_CORE);

        // 2. 환불 요청/응답
        await channel.assertQueue(QUEUES.REFUND_REQ_ADMIN, { durable: true });
        await channel.bindQueue(QUEUES.REFUND_REQ_ADMIN, EXCHANGE, ROUTING_KEYS.REFUND_REQ_ADMIN);
        await channel.assertQueue(QUEUES.REFUND_RES_CORE, { durable: true });
        await channel.bindQueue(QUEUES.REFUND_RES_CORE, EXCHANGE, ROUTING_KEYS.REFUND_RES_CORE);

        // 3. 대시보드용 큐 바인딩 추가
        await channel.assertQueue(QUEUES.DASHBOARD_ALL, { durable: true });
        await channel.bindQueue(QUEUES.DASHBOARD_ALL, EXCHANGE, ROUTING_KEYS.DASHBOARD_ALL);

        console.log("✅ RabbitMQ 연결 및 모든 큐(이벤트/환불/대시보드) 바인딩 성공");
    } catch (error) {
        console.error("❌ RabbitMQ 연결 실패:", error);
    }
};

const publishToQueue = async (routingKey, message) => {
    if (!channel) {
        console.error("❌ RabbitMQ 채널이 준비되지 않았어.");
        return;
    }
    
    const isSent = channel.publish(
        EXCHANGE, 
        routingKey, 
        Buffer.from(JSON.stringify(message)), 
        { persistent: true, contentType: 'application/json' }
    );
    
    if (!isSent) {
        throw new Error("🚀 RabbitMQ 내부 버퍼가 가득 차서 전송에 실패했습니다.");
    }

    // 전송 확정 대기
    try {
        await channel.waitForConfirms();
    } catch (err) {
        console.error("❌ 메시지 전송 확인 중 오류 발생:", err);
        throw err;
    }
};

const getConnection = () => connection;

module.exports = { 
    connectRabbitMQ, 
    publishToQueue, 
    getConnection, 
    QUEUES, 
    ROUTING_KEYS, 
    EXCHANGE 
};
