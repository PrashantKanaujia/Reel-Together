import express from 'express';
import { createServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

type Role = 'host' | 'moderator' | 'participant';
type Member = { id: string; username: string; role: Role; socketId: string };
type ChatMessage = { id: string; username: string; role: Role; text: string; createdAt: number };
type RequestItem = { id: string; userId: string; username: string; action: 'play' | 'pause' | 'seek' | 'change_video'; time?: number; videoId?: string };
type Playback = { videoId: string; playing: boolean; currentTime: number; updatedAt: number };

class Room {
  members = new Map<string, Member>(); chat: ChatMessage[] = []; requests: RequestItem[] = [];
  playback: Playback;
  constructor(public id: string, public name: string, videoId: string) { this.playback = { videoId, playing: false, currentTime: 0, updatedAt: Date.now() }; }
  get participants() { return [...this.members.values()].map(({ id, username, role }) => ({ id, username, role })); }
  snapshot() { return { roomId: this.id, roomName: this.name, participants: this.participants, playback: this.playback, chat: this.chat, requests: this.requests }; }
}

const app = express(); const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const rooms = new Map<string, Room>();
const nameSchema = z.string().trim().min(1).max(32);
const videoSchema = z.string().regex(/^[\w-]{11}$/);
const idSchema = z.string().min(4).max(12);
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  return res.json({ roomId: room.id, roomName: room.name, participants: room.participants, playback: room.playback });
});
const error = (socket: Socket, message: string) => socket.emit('error_message', { message });
const getRoom = (socket: Socket) => rooms.get(String(socket.data.roomId ?? ''));
const getMember = (socket: Socket, room: Room) => room.members.get(String(socket.data.userId ?? ''));
const snapshot = (room: Room) => io.to(room.id).emit('room_snapshot', room.snapshot());
function applyAction(room: Room, action: RequestItem['action'], input: { time?: number; videoId?: string }, username: string) {
  if (action === 'play') room.playback = { ...room.playback, playing: true, updatedAt: Date.now() };
  if (action === 'pause') room.playback = { ...room.playback, playing: false, currentTime: input.time ?? room.playback.currentTime, updatedAt: Date.now() };
  if (action === 'seek') room.playback = { ...room.playback, currentTime: Math.max(0, input.time ?? 0), updatedAt: Date.now() };
  if (action === 'change_video') room.playback = { videoId: input.videoId ?? room.playback.videoId, playing: false, currentTime: 0, updatedAt: Date.now() };
  io.to(room.id).emit('playback_update', { ...room.playback, action, by: username });
}

io.on('connection', (socket) => {
  socket.on('create_room', (payload: unknown, ack?: (v: unknown) => void) => {
    const parsed = z.object({ username: nameSchema, roomName: z.string().trim().max(48).optional(), videoId: videoSchema.optional() }).safeParse(payload);
    if (!parsed.success) return ack?.({ ok: false, message: 'Enter a valid name and YouTube video.' });
    let id = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(id)) id = randomBytes(3).toString('hex').toUpperCase();
    const room = new Room(id, parsed.data.roomName || `${parsed.data.username}'s watch party`, parsed.data.videoId || 'jfKfPfyJRdk');
    const host: Member = { id: randomUUID(), username: parsed.data.username, role: 'host', socketId: socket.id };
    room.members.set(host.id, host); rooms.set(id, room); socket.join(id); socket.data.roomId = id; socket.data.userId = host.id;
    ack?.({ ok: true, userId: host.id, snapshot: room.snapshot() }); snapshot(room);
  });

  socket.on('join_room', (payload: unknown, ack?: (v: unknown) => void) => {
    const parsed = z.object({ roomId: idSchema, username: nameSchema }).safeParse(payload);
    if (!parsed.success) return ack?.({ ok: false, message: 'Enter a valid name and room code.' });
    const room = rooms.get(parsed.data.roomId.toUpperCase());
    if (!room) return ack?.({ ok: false, message: 'We couldn’t find that room. Check the code and try again.' });
    if (room.participants.some((p) => p.username.toLowerCase() === parsed.data.username.toLowerCase())) return ack?.({ ok: false, message: 'That name is already in this room.' });
    const member: Member = { id: randomUUID(), username: parsed.data.username, role: 'participant', socketId: socket.id };
    room.members.set(member.id, member); socket.join(room.id); socket.data.roomId = room.id; socket.data.userId = member.id;
    ack?.({ ok: true, userId: member.id, snapshot: room.snapshot() });
    socket.to(room.id).emit('user_joined', { username: member.username, role: member.role }); snapshot(room);
  });

  socket.on('playback_action', (payload: unknown) => {
    const room = getRoom(socket); if (!room) return error(socket, 'Join a room first.');
    const member = getMember(socket, room); if (!member) return error(socket, 'You are no longer in this room.');
    const parsed = z.object({ action: z.enum(['play', 'pause', 'seek', 'change_video']), time: z.number().finite().min(0).optional(), videoId: z.string().optional() }).safeParse(payload);
    if (!parsed.success) return error(socket, 'That playback action is invalid.');
    const { action, time, videoId } = parsed.data;
    if (member.role === 'participant') return error(socket, 'Playback is controlled by the host and moderators. Request approval below.');
    if (action === 'seek' && time === undefined) return error(socket, 'Choose a seek position.');
    if (action === 'change_video' && (!videoId || !videoSchema.safeParse(videoId).success)) return error(socket, 'That YouTube video link is not valid.');
    applyAction(room, action, { time, videoId }, member.username);
  });

  socket.on('sync_position', (payload: unknown) => {
    const room = getRoom(socket); if (!room) return;
    const member = getMember(socket, room); const parsed = z.object({ time: z.number().finite().min(0) }).safeParse(payload);
    if (member?.role !== 'host' || !room.playback.playing || !parsed.success) return;
    room.playback = { ...room.playback, currentTime: parsed.data.time, updatedAt: Date.now() };
    socket.to(room.id).emit('playback_update', { ...room.playback, action: 'position', by: member.username });
  });

  socket.on('assign_role', (payload: unknown, ack?: (v: unknown) => void) => {
    const room = getRoom(socket); if (!room) return;
    const actor = getMember(socket, room); const parsed = z.object({ userId: z.string(), role: z.enum(['moderator', 'participant']) }).safeParse(payload);
    if (!parsed.success || actor?.role !== 'host') return ack?.({ ok: false, message: 'Only the host can assign roles.' });
    const target = room.members.get(parsed.data.userId);
    if (!target || target.role === 'host') return ack?.({ ok: false, message: 'That participant cannot be changed.' });
    target.role = parsed.data.role; snapshot(room); ack?.({ ok: true });
  });

  socket.on('remove_participant', (payload: unknown, ack?: (v: unknown) => void) => {
    const room = getRoom(socket); if (!room) return;
    const actor = getMember(socket, room); const parsed = z.object({ userId: z.string() }).safeParse(payload);
    if (!parsed.success || actor?.role !== 'host') return ack?.({ ok: false, message: 'Only the host can remove participants.' });
    const target = room.members.get(parsed.data.userId);
    if (!target || target.role === 'host') return ack?.({ ok: false, message: 'That participant cannot be removed.' });
    io.to(target.socketId).emit('removed_from_room'); io.sockets.sockets.get(target.socketId)?.leave(room.id);
    room.members.delete(target.id); room.requests = room.requests.filter((r) => r.userId !== target.id); snapshot(room); ack?.({ ok: true });
  });

  socket.on('transfer_host', (payload: unknown, ack?: (v: unknown) => void) => {
    const room = getRoom(socket); if (!room) return;
    const actor = getMember(socket, room); const parsed = z.object({ userId: z.string() }).safeParse(payload);
    if (!parsed.success || actor?.role !== 'host') return ack?.({ ok: false, message: 'Only the host can transfer ownership.' });
    const next = room.members.get(parsed.data.userId); if (!next) return ack?.({ ok: false, message: 'Participant not found.' });
    actor.role = 'moderator'; next.role = 'host'; snapshot(room); ack?.({ ok: true });
  });

  socket.on('request_action', (payload: unknown, ack?: (v: unknown) => void) => {
    const room = getRoom(socket); if (!room) return;
    const member = getMember(socket, room);
    const parsed = z.object({ action: z.enum(['play', 'pause', 'seek', 'change_video']), time: z.number().finite().min(0).optional(), videoId: z.string().optional() }).safeParse(payload);
    if (!member || member.role !== 'participant') return ack?.({ ok: false, message: 'Only participants need approval.' });
    if (!parsed.success || (parsed.data.action === 'seek' && parsed.data.time === undefined) || (parsed.data.action === 'change_video' && (!parsed.data.videoId || !videoSchema.safeParse(parsed.data.videoId).success))) return ack?.({ ok: false, message: 'That request is invalid.' });
    room.requests.push({ id: randomUUID(), userId: member.id, username: member.username, action: parsed.data.action, time: parsed.data.time, videoId: parsed.data.videoId });
    snapshot(room); ack?.({ ok: true });
  });

  socket.on('review_request', (payload: unknown, ack?: (v: unknown) => void) => {
    const room = getRoom(socket); if (!room) return;
    const actor = getMember(socket, room); const parsed = z.object({ requestId: z.string(), approve: z.boolean() }).safeParse(payload);
    if (!parsed.success || !actor || actor.role === 'participant') return ack?.({ ok: false, message: 'Only hosts and moderators can review requests.' });
    const index = room.requests.findIndex((r) => r.id === parsed.data.requestId);
    if (index < 0) return ack?.({ ok: false, message: 'Request is no longer available.' });
    const [request] = room.requests.splice(index, 1);
    if (parsed.data.approve) applyAction(room, request.action, request, actor.username);
    snapshot(room); ack?.({ ok: true });
  });

  socket.on('chat_message', (payload: unknown) => {
    const room = getRoom(socket); if (!room) return;
    const member = getMember(socket, room); const parsed = z.object({ text: z.string().trim().min(1).max(500) }).safeParse(payload);
    if (!member || !parsed.success) return;
    room.chat.push({ id: randomUUID(), username: member.username, role: member.role, text: parsed.data.text, createdAt: Date.now() });
    room.chat = room.chat.slice(-100); io.to(room.id).emit('chat_message', room.chat.at(-1));
  });
  socket.on('leave_room', () => leave(socket)); socket.on('disconnect', () => leave(socket));
});

function leave(socket: Socket) {
  const room = getRoom(socket); if (!room) return;
  const member = getMember(socket, room); if (!member || member.socketId !== socket.id) return;
  room.members.delete(member.id); room.requests = room.requests.filter((r) => r.userId !== member.id);
  if (member.role === 'host' && room.members.size) (room.members.values().next().value as Member).role = 'host';
  if (!room.members.size) rooms.delete(room.id); else snapshot(room);
  io.to(room.id).emit('user_left', { username: member.username }); socket.data.roomId = undefined; socket.data.userId = undefined;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url)); const clientDist = path.resolve(currentDir, '../dist');
if (process.env.NODE_ENV === 'production') { app.use(express.static(clientDist)); app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html'))); }
const port = Number(process.env.PORT || 3001); httpServer.listen(port, '0.0.0.0', () => console.log(`ReelTogether listening on ${port}`));
