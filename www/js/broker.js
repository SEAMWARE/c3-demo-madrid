//
// broker.js - the broker's WebSocket transport (GET /ngsi-ld/v1/ws): requests and their responses
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Every message is {metadata, body} (coraine's doc/websocket.md). A request names its method and path in
// metadata, and a requestId of ours that comes back in its response - several in flight at once. The
// broker's first message names the connection: {"metadata": {"connection": "urn:ngsi-ld:WebSocket:..."}}.
//
const TIMEOUT_MS = 30000;

export class Broker {
  constructor(httpUrl) {
    this.httpUrl = httpUrl.replace(/\/+$/, '');
    this.wsUrl = this.httpUrl.replace(/^http/, 'ws') + '/ngsi-ld/v1/ws';
    this.ws = null;
    this.connection = null;                    // the connection's id, from the broker's first message
    this.pending = new Map();                  // requestId -> {resolve, reject, timer}
    this.nextId = 1;
    this.onClose = null;                       // () - the socket closed, whoever closed it
  }

  //
  // connect - resolves once the broker has named the connection
  //
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, 'ngsi-ld.json');
      let named = false;

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const md = msg.metadata || {};

        if (!named && md.connection) {
          named = true;
          this.connection = md.connection;
          resolve(this);
          return;
        }

        const p = (md.requestId !== undefined) ? this.pending.get(md.requestId) : null;
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(md.requestId);
          p.resolve({ status: md.status, headers: md, body: msg.body });
        }
      };

      ws.onerror = () => { if (!named) reject(new Error(`no WebSocket at ${this.wsUrl} - is the broker running with --transports ws?`)); };
      ws.onclose = () => {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the broker closed the connection')); }
        this.pending.clear();
        this.ws = null;
        if (!named) reject(new Error(`the broker closed the WebSocket at ${this.wsUrl}`));
        if (this.onClose) this.onClose();
      };

      this.ws = ws;
    });
  }

  get open() { return this.ws !== null && this.ws.readyState === WebSocket.OPEN; }

  close() { if (this.ws) this.ws.close(); }

  //
  // request - {status, headers, body}; rejects when the socket is gone or the broker does not answer
  //
  request(method, path, body, headers = {}) {
    if (!this.open) return Promise.reject(new Error('not connected to the broker'));

    const requestId = 'r' + this.nextId++;
    const metadata = { method, path, requestId, ...headers };
    if (body !== undefined) metadata['Content-Type'] = 'application/json';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${method} ${path}: no answer in ${TIMEOUT_MS / 1000} s`)); }, TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify(body === undefined ? { metadata } : { metadata, body }));
    });
  }

  //
  // batch - a batch operation ('upsert', 'update') over 'entities', 'chunk' at a time; the entities the
  // broker refused, as [{entityId, error}] - a 207's errors
  //
  async batch(op, entities, { chunk = 100, options = null, onProgress = null } = {}) {
    const errors = [];
    const path = `/ngsi-ld/v1/entityOperations/${op}` + (options ? `?options=${options}` : '');

    for (let ix = 0; ix < entities.length; ix += chunk) {
      const part = entities.slice(ix, ix + chunk);
      const r = await this.request('POST', path, part);

      if (r.status === 207 && r.body && Array.isArray(r.body.errors)) errors.push(...r.body.errors);
      else if (r.status >= 400) errors.push({ entityId: part.map((e) => e.id).join(', '), error: r.body || { status: r.status } });

      if (onProgress) onProgress(Math.min(ix + chunk, entities.length), entities.length);
    }

    return errors;
  }

  //
  // entities - GET /ngsi-ld/v1/entities, every page of them
  //
  async entities(type, attrs = null) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const q = `type=${encodeURIComponent(type)}&limit=1000&offset=${offset}` + (attrs ? `&attrs=${attrs}` : '');
      const r = await this.request('GET', `/ngsi-ld/v1/entities?${q}`);
      if (r.status !== 200 || !Array.isArray(r.body)) break;
      out.push(...r.body);
      if (r.body.length < 1000) break;
    }
    return out;
  }
}
