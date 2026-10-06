// Room registry + the single 60 Hz simulation loop for every room.

import crypto from 'node:crypto';
import { Room } from './room.js';
import { cleanCode, cleanSettings } from '../shared/protocol.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMPTY_TTL_MS = 120000;

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this._timer = setInterval(() => this._tick(1 / 60), 1000 / 60);
  }

  _newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let s = '';
      for (let i = 0; i < 5; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(s)) return s;
    }
    return null;
  }

  handle(client, msg) {
    switch (msg.t) {
      case 'create':
        return this.create(client, msg);
      case 'join':
        return this.join(client, msg);
      default:
        if (client.room) client.room.handle(client, msg);
        return;
    }
  }

  create(client, msg) {
    if (client.room) return client.send({ t: 'err', msg: 'You are already in a room' });
    const code = this._newCode();
    if (!code) return client.send({ t: 'err', msg: 'Server is busy, try again' });
    const room = new Room(code, this);
    room.settings = cleanSettings(msg.settings);
    this.rooms.set(code, room);
    const res = room.addMember(client, msg.name);
    if (res.error) {
      this.rooms.delete(code);
      return client.send({ t: 'err', msg: res.error });
    }
    client.send({ t: 'joined', ...room.welcomePayload(res.member.id) });
    room.broadcastLobby();
    room.broadcastStats();
  }

  join(client, msg) {
    if (client.room) return client.send({ t: 'err', msg: 'You are already in a room' });
    const code = cleanCode(msg.code);
    const room = this.rooms.get(code);
    if (!room) return client.send({ t: 'err', msg: 'Room not found' });
    const res = room.addMember(client, msg.name, msg.token);
    if (res.error) return client.send({ t: 'err', msg: res.error });
    client.send({ t: 'joined', ...room.welcomePayload(res.member.id) });
    if (room.game) {
      if (room.arenaPayload()) client.send({ t: 'arena', ...room.arenaPayload() });
      room.sendStateTo(client);
    }
    room.broadcastLobby();
    room.broadcastStats();
  }

  disconnect(client) {
    if (client.room) client.room.handleDisconnect(client);
  }

  _tick(dt) {
    for (const [code, room] of this.rooms) {
      try {
        room.tick(dt);
      } catch (err) {
        console.error(`[room ${code}] tick error:`, err);
      }
      if (room.members.size === 0) {
        if (!room.emptySince) room.emptySince = Date.now();
        else if (Date.now() - room.emptySince > EMPTY_TTL_MS) this.rooms.delete(code);
      }
    }
  }

  get roomCount() {
    return this.rooms.size;
  }
}
