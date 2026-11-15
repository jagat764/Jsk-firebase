/**
 * Layout (schema) resolution — the read-only half of the original engine.
 *
 * The original panel shipped ten layout profiles. This module keeps exactly the
 * parts that decide *where to read*: per-type node aliases, universal
 * fallbacks, the SimINFO sidecar path, and the evidence-based type detector
 * with its manual override. Nothing here writes to a database.
 */

/** Human names, identical to the original badge text. */
export const SCHEMA_NAMES = {
    1: "Type 1 · clients/messages",
    2: "Type 2 · command queue",
    3: "Type 3 · RTX",
    4: "Type 4 · custom",
    5: "Type 5 · custom",
    6: "Type 6 · All_User Info+SimINFO",
    7: "Type 7 · All_Users DeviceInfo",
    8: "Type 8 · All_User Data+Commands",
    9: "Type 9 · All_User Info + root smsQueue",
    10: "Type 10 · user_data + user_sms",
};

export function schemaName(type) {
    return SCHEMA_NAMES[type] || `Type ${type}`;
}

/** Node aliases per layout — device and message nodes only. */
export const SCHEMA_NODE_ALIASES = {
    1: { clients: ["clients"], messages: ["messages"] },
    2: {
        clients: ["clients", "devices", "device_commands"],
        messages: ["messages", "commands", "device_commands"],
    },
    3: {
        clients: ["clients", "data", "devices"],
        messages: ["messages", "data", "common"],
    },
    4: {
        clients: ["clients", "users", "accounts", "data"],
        messages: ["messages", "sms", "logs", "data"],
    },
    5: {
        clients: ["clients", "nodes", "items", "records", "data"],
        messages: ["messages", "sms", "queue", "logs", "data"],
    },
    6: {
        clients: [
            "All_User/Info",
            "All_Users/Info",
            "All_User/DeviceInfo",
            "All_Users/DeviceInfo",
        ],
        messages: ["All_User/Sms", "All_Users/Sms", "All_User/SMS", "All_Users/SMS"],
    },
    7: {
        clients: [
            "All_Users/DeviceInfo",
            "All_User/DeviceInfo",
            "All_Users/Info",
            "All_User/Info",
        ],
        messages: ["All_Users/Sms", "All_User/Sms", "user_sms"],
    },
    8: {
        clients: [
            "All_User/Data",
            "All_Users/Data",
            "All_User/User",
            "All_User/Info",
            "All_Users/Info",
        ],
        messages: [
            "All_User/Sms",
            "All_Users/Sms",
            "All_User/Commands",
            "All_Users/Commands",
        ],
    },
    9: {
        clients: [
            "All_User/Info",
            "All_Users/Info",
            "All_User/DeviceInfo",
            "All_Users/DeviceInfo",
        ],
        messages: ["All_User/Sms", "All_Users/Sms", "All_User/SMS", "All_Users/SMS"],
    },
    10: {
        clients: ["user_data", "user_list", "clients", "devices"],
        messages: ["user_sms", "messages", "Sms"],
    },
};

/** Always-tried fallbacks, appended after the type-specific aliases. */
export const UNIVERSAL_NODE_FALLBACKS = {
    clients: [
        "All_User/Info",
        "All_Users/Info",
        "All_User/DeviceInfo",
        "All_Users/DeviceInfo",
        "user_data",
        "clients",
        "devices",
    ],
    messages: ["All_User/Sms", "All_Users/Sms", "Sms", "messages", "user_sms"],
};

/**
 * Ordered read candidates for a node kind ("clients" | "messages").
 * `schema` may be null for auto-detect, which uses the universal list first.
 */
export function nodeCandidates(schema, key) {
    const aliases = SCHEMA_NODE_ALIASES[schema]?.[key] || [];
    const universal = UNIVERSAL_NODE_FALLBACKS[key] || [];
    const list = [];
    for (const path of [...(schema ? aliases : []), ...universal, ...(schema ? [] : aliases)]) {
        if (!list.includes(path)) list.push(path);
    }
    if (!list.includes(key)) list.push(key);
    return list;
}

/**
 * SimINFO sidecar for a device node: `All_User/Info` → `All_User/SimINFO`.
 * The `user_data` layout keeps SIM fields inline, so it has no sidecar.
 */
export function simSidecarPath(clientsPath) {
    const path = String(clientsPath || "");
    if (!path) return null;
    if (/^user_data$/i.test(path)) return null;
    const root = path.replace(/\/?(Info|DeviceInfo|Data|User)$/i, "");
    return root && root !== path ? `${root}/SimINFO` : null;
}

/**
 * Pick the sidecar record for one device. The original looked the device up by
 * its `did`, then by the node key.
 */
export function pickSidecar(simsNode, deviceId, nodeKey, rawRecord) {
    if (!simsNode || typeof simsNode !== "object") return null;
    const did = rawRecord?.did || rawRecord?.Did || rawRecord?.device || "";
    for (const key of [did, deviceId, nodeKey]) {
        if (!key) continue;
        const entry = simsNode[String(key)];
        if (entry && typeof entry === "object") return entry;
    }
    return null;
}

/**
 * Evidence-based type detection, mirroring the original rules:
 *
 *  - node path decides the family (All_Users/DeviceInfo → 7, All_User/Data →
 *    8, All_User/Info → 6, user_data → 10)
 *  - `All_User/Info` + a root `smsQueue` promotes 6 → 9
 *  - record fields refine the flat layouts (Sim1/device_name/charge → 3,
 *    Aadhaar/PanCard/Dob → 8)
 *  - a message carrying `sendSms` means a command-queue layout → 2
 *
 * @returns {{type: number, evidence: string[]}}
 */
export function detectSchemaType({
    clientsPath = "",
    firstRecord = null,
    messagesRecord = null,
    rootSmsQueueDetected = false,
} = {}) {
    const evidence = [];
    let type = 1;

    if (/All_Users\/DeviceInfo/i.test(clientsPath)) {
        type = 7;
        evidence.push("clients read from All_Users/DeviceInfo → SIM-map layout");
    } else if (/All_User\/Data|All_Users\/Data/i.test(clientsPath)) {
        type = 8;
        evidence.push("clients read from All_User/Data → data+commands layout");
    } else if (/All_User\/Info|All_User\/DeviceInfo/i.test(clientsPath)) {
        type = 6;
        evidence.push("clients read from All_User/Info → info+SimINFO layout");
    }

    if (type === 6 && rootSmsQueueDetected) {
        type = 9;
        evidence.push("no All_User/Commands node, but root /smsQueue exists → root trigger layout");
    }

    if (/^user_data$/i.test(clientsPath)) {
        type = 10;
        evidence.push("clients read from user_data → user_data + user_sms layout");
    }

    const record = firstRecord && typeof firstRecord === "object" ? firstRecord : null;
    if (type === 1 && record) {
        if (record.Sim1 !== undefined || record.device_name !== undefined || record.charge !== undefined) {
            type = 3;
            evidence.push("clients carry Sim1/device_name/charge → RTX layout");
        } else if (record.sims !== undefined || record.mobNo !== undefined || record.modelName !== undefined) {
            evidence.push("clients carry sims/mobNo/modelName → standard layout");
        }
        if (
            record.aadhaar !== undefined ||
            record.panCard !== undefined ||
            record.dob !== undefined ||
            record.Aadhaar !== undefined ||
            record.PanCard !== undefined ||
            record.Dob !== undefined
        ) {
            type = 8;
            evidence.push("clients carry Aadhaar/PanCard/Dob → data+commands layout");
        }
    }

    const message = messagesRecord && typeof messagesRecord === "object" ? messagesRecord : null;
    if (type !== 3 && message && message.sendSms !== undefined) {
        type = 2;
        evidence.push("messages carry sendSms → command-queue layout");
    }

    if (!evidence.length) evidence.push("no distinguishing fields found → default layout");
    return { type, evidence };
}

/** Apply the manual override on top of the detected type. */
export function effectiveSchema(override, detected) {
    return Number.isInteger(override) && override >= 1 ? override : detected;
}
