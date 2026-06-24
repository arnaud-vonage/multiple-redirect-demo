import { vcr, Voice } from "@vonage/vcr-sdk";
import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';

const app = express();
const port = process.env.VCR_PORT;

const VONAGE_NUMBER = process.env.VONAGE_NUMBER;
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
    const liveState = getLiveState();
    for (const client of sseClients) {
        writeSseEvent(client, 'update', liveState);
    }
};

const session = vcr.createSession();
const voice = new Voice(session);

await voice.onCall('answer');
await voice.onCallEvent({ callback: "event" });

app.use(express.json());
app.use(express.static('public'));

app.get('/_/health', async (req, res) => {
    res.sendStatus(200);
});

app.get('/_/metrics', async (req, res) => {
    res.sendStatus(200);
});

app.get('/_/debug/recent-events', async (req, res) => {
    res.json(recentEvents);
});

app.get('/_/debug/live-state', async (req, res) => {
    res.json(getLiveState());
});

app.get('/_/debug/live', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    writeSseEvent(res, 'snapshot', getLiveState());

    req.on('close', () => {
        sseClients.delete(res);
    });
});

app.get('/_/mappings', async (req, res) => {
    res.json({ mappings: listNumberMappings() });
});

app.post('/_/mappings', async (req, res) => {
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
    console.log(`/answer | req.body: ${JSON.stringify(req.body)}`);
    const { to, from, uuid, conversation_uuid: conversationUuid } = req.body;
    const normalizedTo = normalizePhone(to);
    const mappedDestination = numberMappings.get(normalizedTo);
    const destination = mappedDestination || '';
    const outboundFrom = normalizePhone(VONAGE_NUMBER) || normalizedTo;
    const dialDestination = toDialablePhone(destination);
    const dialFrom = toDialablePhone(outboundFrom);
    const routeSource = mappedDestination ? 'mapping' : 'unmapped';

    console.log(`/answer | normalizedTo=${normalizedTo} | destination=${destination} | dialDestination=${dialDestination} | routeSource=${routeSource}`);
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
        ncco.push({
            "action": "connect",
            "from": dialFrom,
            "endpoint": [{
                "type": "phone",
                "number": dialDestination
            }]
        });
    } else {
        ncco[0].text = "We could not route your call at this time";
    }

    res.json(ncco);
});

app.post('/event', async (req, res) => {
    console.log(`/event | req.body: ${JSON.stringify(req.body)}`);
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