import { vcr, Voice } from "@vonage/vcr-sdk";
import { verifySignature } from '@vonage/jwt';
import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';

const app = express();
const port = process.env.VCR_PORT;

// Required behind VCR reverse proxy so req.protocol reflects external HTTPS.
app.set('trust proxy', true);

const VONAGE_NUMBER = process.env.VONAGE_NUMBER;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const WEBHOOK_SIGNATURE_SECRET = process.env.WEBHOOK_SIGNATURE_SECRET;
const ENABLE_DEBUG_ROUTES = process.env.ENABLE_DEBUG_ROUTES === 'true';
const mappingFile = new URL('./number-mapping.csv', import.meta.url);

const normalizePhone = (value) => {
    if (!value) {
        return '';
    }

    const trimmed = String(value).trim();
    const digitsOnly = trimmed.replace(/\D/g, '');

    if (!digitsOnly) {
        return '';
    }

    return `+${digitsOnly}`;
};

const toDialablePhone = (value) => normalizePhone(value).replace(/^\+/, '');

const maskPhone = (value) => {
    const normalized = normalizePhone(value);

    if (!normalized) {
        return null;
    }

    const visibleDigits = normalized.slice(-4);
    return `***${visibleDigits}`;
};

const getBearerToken = (req) => {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match?.[1] || '';
};

const requireAdminAuth = (req, res, next) => {
    if (!ADMIN_API_KEY) {
        res.status(503).json({ error: 'admin api is not configured' });
        return;
    }

    const token = req.get('x-admin-api-key') || req.query?.adminKey || getBearerToken(req);
    if (token !== ADMIN_API_KEY) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    next();
};

const isValidSignedWebhook = (req) => {
    if (!WEBHOOK_SIGNATURE_SECRET) {
        console.log('[DEBUG] isValidSignedWebhook: WEBHOOK_SIGNATURE_SECRET not configured');
        return false;
    }

    const signedJwt = getBearerToken(req);
    if (!signedJwt) {
        console.log('[DEBUG] isValidSignedWebhook: No Bearer token found in Authorization header');
        return false;
    }

    const isValid = verifySignature(signedJwt, WEBHOOK_SIGNATURE_SECRET);
    console.log(`[DEBUG] isValidSignedWebhook: JWT verification result = ${isValid}`);
    return isValid;
};

const requireWebhookAuth = (req, res, next) => {
    console.log(`[DEBUG] requireWebhookAuth: Authorization header = ${req.get('authorization') || 'none'}`);
    
    if (isValidSignedWebhook(req)) {
        console.log('[DEBUG] requireWebhookAuth: Passed JWT verification');
        next();
        return;
    }

    if (!WEBHOOK_SIGNATURE_SECRET) {
        console.log('[DEBUG] requireWebhookAuth: WEBHOOK_SIGNATURE_SECRET not configured, returning 503');
        res.status(503).json({ error: 'webhook auth is not configured' });
        return;
    }

    console.log('[DEBUG] requireWebhookAuth: JWT verification failed, returning 401');
    res.status(401).json({ error: 'unauthorized' });
};

const sanitizeWebhookPayload = (payload = {}) => {
    const sanitized = { ...payload };

    if ('from' in sanitized) {
        sanitized.from = maskPhone(sanitized.from);
    }

    if ('to' in sanitized) {
        sanitized.to = maskPhone(sanitized.to);
    }

    return sanitized;
};

const sanitizeCallRecord = (record) => ({
    ...record,
    inboundFrom: maskPhone(record.inboundFrom),
    inboundTo: maskPhone(record.inboundTo),
    destination: maskPhone(record.destination),
    dialDestination: maskPhone(record.dialDestination),
    outboundFrom: maskPhone(record.outboundFrom),
    dialFrom: maskPhone(record.dialFrom)
});

const getSanitizedLiveState = () => ({
    now: new Date().toISOString(),
    calls: callRecords.map(sanitizeCallRecord)
});

const getSanitizedRecentEvents = () => recentEvents.map((event) => ({
    ...event,
    normalizedTo: maskPhone(event.normalizedTo),
    destination: maskPhone(event.destination),
    dialDestination: maskPhone(event.dialDestination),
    outboundFrom: maskPhone(event.outboundFrom),
    dialFrom: maskPhone(event.dialFrom),
    body: sanitizeWebhookPayload(event.body)
}));

const loadNumberMappings = () => {
    const mappingCsv = readFileSync(mappingFile, 'utf8');
    const mappings = new Map();

    for (const line of mappingCsv.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }

        const [sourceRaw, destinationRaw] = trimmedLine.split(',').map((item) => item?.trim());
        const source = normalizePhone(sourceRaw);
        const destination = normalizePhone(destinationRaw);

        if (!source || !destination) {
            continue;
        }

        mappings.set(source, destination);
    }

    return mappings;
};

const listNumberMappings = () => Array.from(numberMappings.entries())
    .sort(([sourceA], [sourceB]) => sourceA.localeCompare(sourceB))
    .map(([source, destination]) => ({ source, destination }));

const persistNumberMappings = () => {
    const csv = listNumberMappings()
        .map(({ source, destination }) => `${source},${destination}`)
        .join('\n');

    writeFileSync(mappingFile, `${csv}${csv ? '\n' : ''}`, 'utf8');
};

const numberMappings = loadNumberMappings();
const recentEvents = [];
const MAX_RECENT_EVENTS = 50;
const callRecords = [];
const MAX_CALL_RECORDS = 100;
const sseClients = new Set();

const appendRecentEvent = (event) => {
    recentEvents.push({
        timestamp: new Date().toISOString(),
        ...event
    });

    if (recentEvents.length > MAX_RECENT_EVENTS) {
        recentEvents.shift();
    }
};

const upsertCallRecord = (key, payload) => {
    const now = new Date().toISOString();
    const index = callRecords.findIndex((record) => record.key === key);

    if (index === -1) {
        callRecords.unshift({
            key,
            createdAt: now,
            updatedAt: now,
            ...payload
        });
    } else {
        callRecords[index] = {
            ...callRecords[index],
            ...payload,
            updatedAt: now
        };
    }

    if (callRecords.length > MAX_CALL_RECORDS) {
        callRecords.pop();
    }
};

const getLiveState = () => ({
    now: new Date().toISOString(),
    calls: callRecords
});

const writeSseEvent = (res, eventName, data) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const broadcastLiveUpdate = () => {
    const liveState = getSanitizedLiveState();
    for (const client of sseClients) {
        writeSseEvent(client, 'update', liveState);
    }
};

const session = vcr.createSession();
const voice = new Voice(session);

const eventCallbackPath = 'event';

await voice.onCall('answer');
await voice.onCallEvent({ callback: eventCallbackPath });

app.use(express.json());
app.use(express.static('public'));

app.get('/_/health', async (req, res) => {
    res.sendStatus(200);
});

app.get('/_/metrics', async (req, res) => {
    res.sendStatus(200);
});

app.get('/_/debug/recent-events', async (req, res) => {
    if (!ENABLE_DEBUG_ROUTES) {
        res.sendStatus(404);
        return;
    }

    requireAdminAuth(req, res, () => {
        res.json(getSanitizedRecentEvents());
    });
});

app.get('/_/debug/live-state', async (req, res) => {
    requireAdminAuth(req, res, () => {
        res.json(getSanitizedLiveState());
    });
});

app.get('/_/debug/live', async (req, res) => {
    let isAuthorized = false;
    requireAdminAuth(req, res, () => {
        isAuthorized = true;
    });

    if (!isAuthorized) {
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sseClients.add(res);
    writeSseEvent(res, 'snapshot', getSanitizedLiveState());

    req.on('close', () => {
        sseClients.delete(res);
    });
});

app.get('/_/mappings', async (req, res) => {
    requireAdminAuth(req, res, () => {
        res.json({ mappings: listNumberMappings() });
    });
});

app.post('/_/mappings', async (req, res) => {
    let isAuthorized = false;
    requireAdminAuth(req, res, () => {
        isAuthorized = true;
    });

    if (!isAuthorized) {
        return;
    }

    const source = normalizePhone(req.body?.source);
    const destination = normalizePhone(req.body?.destination);

    if (!source || !destination) {
        res.status(400).json({ error: 'source and destination must be valid phone numbers' });
        return;
    }

    numberMappings.set(source, destination);
    persistNumberMappings();

    res.json({ mappings: listNumberMappings() });
});

app.delete('/_/mappings/:source', async (req, res) => {
    let isAuthorized = false;
    requireAdminAuth(req, res, () => {
        isAuthorized = true;
    });

    if (!isAuthorized) {
        return;
    }

    const source = normalizePhone(req.params.source);

    if (!source) {
        res.status(400).json({ error: 'source must be a valid phone number' });
        return;
    }

    if (!numberMappings.has(source)) {
        res.status(404).json({ error: 'mapping not found' });
        return;
    }

    numberMappings.delete(source);
    persistNumberMappings();

    res.json({ mappings: listNumberMappings() });
});

app.post('/answer', async (req, res) => {
    console.log('[DEBUG] /answer endpoint called');\n    let isAuthorized = false;
    requireWebhookAuth(req, res, () => {
        isAuthorized = true;
    });

    if (!isAuthorized) {
        console.log('[DEBUG] /answer: Authorization failed, returning early');
        return;
    }
    console.log('[DEBUG] /answer: Authorization passed');

    const { to, from, uuid, conversation_uuid: conversationUuid } = req.body;
    const normalizedTo = normalizePhone(to);
    const mappedDestination = numberMappings.get(normalizedTo);
    const destination = mappedDestination || '';
    const forwardedProto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const webhookBaseUrl = `${forwardedProto}://${req.get('host')}`;
    const connectEventUrl = `${webhookBaseUrl}/${eventCallbackPath}`;
    const outboundFrom = normalizePhone(VONAGE_NUMBER) || normalizedTo;
    const dialDestination = toDialablePhone(destination);
    const dialFrom = toDialablePhone(outboundFrom);
    const routeSource = mappedDestination ? 'mapping' : 'unmapped';

    console.log(`/answer | normalizedTo=${maskPhone(normalizedTo)} | destination=${maskPhone(destination)} | routeSource=${routeSource}`);
    appendRecentEvent({
        type: 'answer',
        normalizedTo,
        destination,
        dialDestination,
        outboundFrom,
        dialFrom,
        routeSource,
        body: req.body
    });

    const callKey = uuid || conversationUuid || `answer-${Date.now()}`;
    upsertCallRecord(callKey, {
        callUuid: uuid || null,
        conversationUuid: conversationUuid || null,
        inboundFrom: normalizePhone(from),
        inboundTo: normalizedTo,
        destination,
        dialDestination,
        outboundFrom,
        dialFrom,
        routeSource,
        status: 'answer_webhook',
        detail: 'ncco_issued'
    });
    broadcastLiveUpdate();

    const ncco = [{
        "action": "talk",
        "text": "お電話ありがとうございます。ただいま担当者へおつなぎします。しばらくお待ちください。",
        "language": "ja-JP",
        "style": 0
    }];

    if (destination) {
        const connectAction = {
            "action": "connect",
            "endpoint": [{
                "type": "phone",
                "number": dialDestination
            }],
            // Explicit event callback for connect leg updates and failures.
            "eventUrl": [connectEventUrl],
            "eventMethod": "POST"
        };

        if (dialFrom) {
            connectAction.from = dialFrom;
        }

        ncco.push(connectAction);
    } else {
        ncco[0].text = "We could not route your call at this time";
    }

    res.json(ncco);
});

app.post('/event', async (req, res) => {
    console.log('[DEBUG] /event endpoint called');
    let isAuthorized = false;
    requireWebhookAuth(req, res, () => {
        isAuthorized = true;
    });

    if (!isAuthorized) {
        console.log('[DEBUG] /event: Authorization failed, returning early');
        return;
    }
    
    console.log('[DEBUG] /event: Authorization passed');

    if (req.body?.status || req.body?.detail) {
        console.log(`/event | status=${req.body.status} | detail=${req.body.detail || 'n/a'}`);
    }
    appendRecentEvent({
        type: 'event',
        body: req.body
    });

    const {
        uuid,
        conversation_uuid: conversationUuid,
        from,
        to,
        status,
        detail,
        direction,
        sip_code: sipCode,
        disconnected_by: disconnectedBy,
        duration
    } = req.body;

    const callKey = uuid || conversationUuid || `event-${Date.now()}`;
    upsertCallRecord(callKey, {
        callUuid: uuid || null,
        conversationUuid: conversationUuid || null,
        inboundFrom: normalizePhone(from),
        inboundTo: normalizePhone(to),
        status: status || 'event',
        detail: detail || null,
        direction: direction || null,
        sipCode: sipCode || null,
        disconnectedBy: disconnectedBy || null,
        duration: duration || null
    });
    broadcastLiveUpdate();

    res.sendStatus(200);
});

app.listen(port, () => {
    console.log(`App listening on port ${port}`)
});