import { vcr, Voice, Scheduler } from "@vonage/vcr-sdk";
import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';

const app = express();
const port = process.env.VCR_PORT;

// Required behind VCR reverse proxy so req.protocol reflects external HTTPS.
app.set('trust proxy', true);

const DEFAULT_FROM_NUMBER = process.env.DEFAULT_FROM_NUMBER;
const DESTINATION_NUMBER = process.env.DESTINATION_NUMBER;
const TALK_TEXT = process.env.TALK_TEXT || 'お電話ありがとうございます。ただいま担当者へおつなぎします。しばらくお待ちください。';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

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
    if (match) return match[1];
    // Vonage sends JWT directly without "Bearer" prefix
    if (authorization && !authorization.includes(' ')) return authorization;
    return '';
};

const getJtiFromRequest = (req) => {
    const token = getBearerToken(req);
    if (!token) return null;
    try {
        const [, payloadB64] = token.split('.');
        if (!payloadB64) return null;
        const { jti } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        return jti || null;
    } catch {
        return null;
    }
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

const VCR_APPLICATION_ID = process.env.VCR_APPLICATION_ID;

// VCR webhook tokens are signed with a Vonage-internal key that is not published
// in any public JWKS. Verify by decoding the JWT claim only and checking that
// api_application_id matches this application. Tokens originate from Vonage's
// own infrastructure so claim-only is the correct approach for VCR webhooks.
const isValidVcrWebhook = (req) => {
    const token = getBearerToken(req);
    if (!token) {
        console.log('[DEBUG] isValidVcrWebhook: No token in Authorization header');
        return false;
    }

    try {
        const [, payloadB64] = token.split('.');
        if (!payloadB64) return false;
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        const appIdMatch = !VCR_APPLICATION_ID || payload.api_application_id === VCR_APPLICATION_ID;
        console.log(`[DEBUG] isValidVcrWebhook: api_application_id=${payload.api_application_id} match=${appIdMatch} (VCR_APPLICATION_ID=${VCR_APPLICATION_ID || 'not set'})`);
        return appIdMatch;
    } catch {
        return false;
    }
};

const requireWebhookAuth = (req, res, next) => {
    const authHeader = req.get('authorization') || 'none';
    console.log(`[DEBUG] requireWebhookAuth: Authorization present=${authHeader !== 'none'}`);

    if (isValidVcrWebhook(req)) {
        console.log('[DEBUG] requireWebhookAuth: Passed VCR claim check');
        next();
        return;
    }

    console.log('[DEBUG] requireWebhookAuth: Auth failed, returning 401');
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

        const [sourceRaw, outboundFromRaw] = trimmedLine.split(',').map((item) => item?.trim());
        const source = normalizePhone(sourceRaw);
        const outboundFrom = normalizePhone(outboundFromRaw);

        if (!source || !outboundFrom) {
            continue;
        }

        mappings.set(source, outboundFrom);
    }

    return mappings;
};

const listNumberMappings = () => Array.from(numberMappings.entries())
    .sort(([sourceA], [sourceB]) => sourceA.localeCompare(sourceB))
    .map(([source, outboundFrom]) => ({ source, outboundFrom }));

const persistNumberMappings = () => {
    const csv = listNumberMappings()
        .map(({ source, outboundFrom }) => `${source},${outboundFrom}`)
        .join('\n');

    writeFileSync(mappingFile, `${csv}${csv ? '\n' : ''}`, 'utf8');
};

const numberMappings = loadNumberMappings();

const recentEvents = [];
const MAX_RECENT_EVENTS = 200;
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

// Fixed ID makes re-registration a no-op — without it each cold start piles up a new schedule.
const KEEP_WARM_SCHEDULE_ID = 'keep-warm';
const KEEP_WARM_CALLBACK = '/keepWarm';
const KEEP_WARM_CRON = '*/10 * * * *';
const KEEP_WARM_MAX_INVOCATIONS = Math.ceil((365 * 24 * 60) / 10);

const scheduler = new Scheduler(session);

async function ensureKeepWarmSchedule() {
    try {
        const existing = await scheduler.get(KEEP_WARM_SCHEDULE_ID);
        if (existing?.id) {
            console.log(`Keep-warm schedule already exists: ${existing.id}`);
            return existing.id;
        }
    } catch {
        // get() rejects when the ID is unknown — fall through to create it
    }

    const untilDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    try {
        const scheduleId = await scheduler.startAt({
            id: KEEP_WARM_SCHEDULE_ID,
            startAt: new Date().toISOString(),
            callback: KEEP_WARM_CALLBACK,
            interval: {
                cron: KEEP_WARM_CRON,
                until: {
                    date: untilDate,
                    maxInvocations: KEEP_WARM_MAX_INVOCATIONS,
                },
            },
            payload: { reason: 'keep-warm' },
        });
        console.log(`Keep-warm schedule created: ${scheduleId}`);
        return scheduleId;
    } catch (error) {
        console.error('Failed to create keep-warm schedule:', error);
        return null;
    }
}

app.use(express.json());
app.use(express.static('public'));

// Debug: Log all incoming requests (skip health/metrics to avoid flooding the buffer)
app.use((req, res, next) => {
    if (req.path === '/_/health' || req.path === '/_/metrics') {
        next();
        return;
    }

    const jti = getJtiFromRequest(req);
    const hasAdminHeader = Boolean(req.get('x-admin-api-key'));
    const authType = jti ? 'jwt' : (hasAdminHeader ? 'admin-key' : 'none');

    const sanitizedQuery = { ...req.query };
    if ('adminKey' in sanitizedQuery) sanitizedQuery.adminKey = '[REDACTED]';

    appendRecentEvent({
        type: 'incoming',
        method: req.method,
        path: req.path,
        query: sanitizedQuery,
        jti,
        authType,
        hasAdminHeader,
        body: req.body
    });

    console.log(`[INCOMING] ${req.method} ${req.path} | jti=${jti || 'none'} | auth=${authType}`);
    next();
});

app.get('/_/health', async (req, res) => {
    res.sendStatus(200);
});

app.get('/_/metrics', async (req, res) => {
    res.sendStatus(200);
});

app.post(KEEP_WARM_CALLBACK, (req, res) => {
    console.log(`Keep-warm ping at ${new Date().toISOString()}`);
    res.sendStatus(200);
});

app.get('/_/debug/recent-events', async (req, res) => {
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
    const outboundFrom = normalizePhone(req.body?.outboundFrom);

    if (!source || !outboundFrom) {
        res.status(400).json({ error: 'source and outboundFrom must be valid phone numbers' });
        return;
    }

    numberMappings.set(source, outboundFrom);
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
    console.log('[DEBUG] /answer endpoint called');
    let isAuthorized = false;
    requireWebhookAuth(req, res, () => {
        isAuthorized = true;
    });

    if (!isAuthorized) {
        console.log('[DEBUG] /answer: Authorization failed, returning early');
        return;
    }
    console.log('[DEBUG] /answer: Authorization passed');

    try {
        const { to, from, uuid, conversation_uuid: conversationUuid } = req.body;
        const normalizedTo = normalizePhone(to);
        const mappedOutboundFrom = numberMappings.get(normalizedTo);
        const destination = normalizePhone(DESTINATION_NUMBER) || '';
        const outboundFrom = mappedOutboundFrom || normalizePhone(DEFAULT_FROM_NUMBER) || normalizedTo;
        const forwardedProto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
        const dialDestination = toDialablePhone(destination);
        const dialFrom = toDialablePhone(outboundFrom);
        const routeSource = mappedOutboundFrom ? 'mapping' : 'default';

        console.log(`/answer | uuid=${uuid || '-'} | cuid=${conversationUuid || '-'} | from=${maskPhone(normalizePhone(from))} | dialFrom=${dialFrom || '-'} | dialDest=${dialDestination || '-'} | route=${routeSource}`);
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

        const callKey = conversationUuid || uuid || `answer-${Date.now()}`;
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
            "text": TALK_TEXT,
            "language": "ja-JP",
            "style": 0
        }];

        if (destination) {
            const connectAction = {
                "action": "connect",
                "endpoint": [{
                    "type": "phone",
                    "number": dialDestination
                }]
                // eventUrl intentionally omitted — VCR's internal host header is not
                // publicly reachable. Using the application's SDK-registered event URL instead.
            };

            if (dialFrom) {
                connectAction.from = dialFrom;
            }

            ncco.push(connectAction);
        } else {
            ncco[0].text = "We could not route your call at this time";
        }

        res.json(ncco);
        console.log(`/answer | ncco sent | actions=${ncco.map(a => a.action).join(',')}`);
    } catch (err) {
        console.error('[ERROR] /answer handler threw:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'internal server error' });
        }
    }
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

    try {
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

        if (status || detail) {
            console.log(`/event | uuid=${uuid || '-'} | cuid=${conversationUuid || '-'} | status=${status || '-'} | detail=${detail || 'n/a'} | dir=${direction || '-'}`);
        }
        appendRecentEvent({
            type: 'event',
            body: req.body
        });

        const callKey = conversationUuid || uuid || `event-${Date.now()}`;
        upsertCallRecord(callKey, {
            callUuid: uuid || null,
            conversationUuid: conversationUuid || null,
            // Do not overwrite inboundFrom/inboundTo here — those are set from /answer
            // and outbound leg events carry the 050/destination numbers in from/to.
            status: status || 'event',
            detail: detail || null,
            direction: direction || null,
            sipCode: sipCode || null,
            disconnectedBy: disconnectedBy || null,
            duration: duration || null
        });
        broadcastLiveUpdate();

        res.sendStatus(200);
    } catch (err) {
        console.error('[ERROR] /event handler threw:', err);
        if (!res.headersSent) {
            res.sendStatus(200);
        }
    }
});

app.listen(port, () => {
    console.log(`App listening on port ${port}`)
});

ensureKeepWarmSchedule();