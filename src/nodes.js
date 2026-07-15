'use strict';

class NodeConfigError extends TypeError {
    constructor(code) {
        super(code);
        this.name = 'NodeConfigError';
        this.code = code;
    }
}

function fail(code) {
    throw new NodeConfigError(code);
}

function isNodeRow(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && ['url', 'auth', 'username', 'password'].some(key => Object.prototype.hasOwnProperty.call(value, key));
}

function inputRows(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) fail('empty-node-list');
        if (trimmed[0] === '[' || trimmed[0] === '{') {
            try { value = JSON.parse(trimmed); }
            catch { fail('invalid-json'); }
        } else {
            return trimmed.split(/[\r\n,]+/).filter(Boolean);
        }
    }

    if (isNodeRow(value)) return [value];
    if (!Array.isArray(value)) fail('invalid-node-list');
    return value.slice();
}

function boolValue(value) {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value == null ? '' : value).trim().toLowerCase());
}

function normalizeRow(value) {
    const row = typeof value === 'string' ? { url: value, auth: 'none' } : value;
    if (!isNodeRow(row)) fail('invalid-node');

    const url = String(row.url == null ? '' : row.url).trim().replace(/\/+$/, '');
    if (!url || /\s/.test(url)) fail('invalid-url');

    let parsed;
    try { parsed = new URL(url); }
    catch { fail('invalid-url'); }
    if (parsed.username || parsed.password) fail('embedded-credentials');
    if (!parsed.hostname) fail('invalid-url');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('invalid-scheme');
    if (parsed.search || parsed.hash) fail('invalid-url');

    let auth = String(row.auth == null ? 'none' : row.auth).trim().toLowerCase();
    if (!auth) auth = 'none';
    if (!['none', 'basic', 'digest'].includes(auth)) fail('invalid-auth');

    let username = String(row.username == null ? '' : row.username);
    let password = String(row.password == null ? '' : row.password);
    const allowInsecureHttp = boolValue(row.allow_insecure_http);
    if (auth === 'none') {
        username = '';
        password = '';
    } else {
        if (!username || !password) fail('missing-credentials');
        if (username.includes(':')) fail('invalid-username');
        if (parsed.protocol === 'http:' && !allowInsecureHttp) fail('insecure-http-auth');
    }

    return {
        url,
        auth,
        username,
        password,
        allow_insecure_http: allowInsecureHttp,
    };
}

function normalizeNodes(value) {
    const nodes = inputRows(value).map(normalizeRow);
    if (nodes.length === 0) fail('empty-node-list');
    return nodes;
}

function nodesFromEnv(env = process.env) {
    const json = String(env.XMR_NODES_JSON == null ? '' : env.XMR_NODES_JSON).trim();
    return normalizeNodes(json || env.XMR_NODES || '');
}

function publicUrl(value) {
    try {
        const parsed = new URL(String(value));
        const path = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.protocol.toLowerCase()}//${parsed.host}${path}`;
    } catch { return ''; }
}

function publicNodes(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map(node => ({
        url: publicUrl(node && node.url),
        auth: node && node.auth ? String(node.auth) : 'none',
        allow_insecure_http: !!(node && node.allow_insecure_http),
    }));
}

function toMoneroConnection(node) {
    return node.auth === 'none'
        ? node.url
        : { uri: node.url, username: node.username, password: node.password };
}

module.exports = { NodeConfigError, normalizeNodes, nodesFromEnv, publicNodes, toMoneroConnection };
