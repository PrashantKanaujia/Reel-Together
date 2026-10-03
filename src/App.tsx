import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { ArrowDownLeft, ArrowRight, Check, CheckCheck, CircleHelp, Clapperboard, Crown, ExternalLink, Headphones, Link2, LoaderCircle, MessageCircle, MoreHorizontal, Music2, Pause, Play, Plus, Radio, Send, Shield, ShieldCheck, Sparkles, Users, Volume2, X } from 'lucide-react';

type Role = 'host' | 'moderator' | 'participant';
type Participant = { id: string; username: string; role: Role };
type Playback = { videoId: string; playing: boolean; currentTime: number; updatedAt: number };
type ChatMessage = { id: string; username: string; role: Role; text: string; createdAt: number };
type RequestItem = { id: string; userId: string; username: string; action: 'play' | 'pause' | 'seek' | 'change_video'; time?: number; videoId?: string };
type Snapshot = { roomId: string; roomName: string; participants: Participant[]; playback: Playback; chat: ChatMessage[]; requests: RequestItem[] };
type Ack = { ok: boolean; message?: string; userId?: string; snapshot?: Snapshot };
declare global { interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void } }
const socket: Socket = io({ autoConnect: false });
const getVideoId = (value: string) => {
  const trimmed = value.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try { const url = new URL(trimmed); if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1).slice(0, 11); return url.searchParams.get('v') || url.pathname.match(/(?:embed|shorts)\/([\w-]{11})/)?.[1] || ''; } catch { return ''; }
};
const roleNames: Record<Role, string> = { host: 'Host', moderator: 'Moderator', participant: 'Participant' };
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');

function YouTubePlayer({ playback, canControl, isHost, onAction }: { playback: Playback; canControl: boolean; isHost: boolean; onAction: (action: string, data?: Record<string, number | string>) => void }) {
  const frame = useRef<HTMLDivElement>(null); const player = useRef<any>(null);
  const latestPlayback = useRef(playback); latestPlayback.current = playback;
  const [muted, setMuted] = useState(false); const [duration, setDuration] = useState(0); const [progress, setProgress] = useState(0);
  useEffect(() => {
    let alive = true;
    const makePlayer = () => {
      if (!alive || !frame.current || !window.YT?.Player) return;
      player.current = new window.YT.Player(frame.current, { width: '100%', height: '100%', videoId: latestPlayback.current.videoId, playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 }, events: {
        onReady: (event: any) => { const current = latestPlayback.current; const loadedId = event.target.getVideoData?.().video_id; if (loadedId !== current.videoId) event.target.cueVideoById(current.videoId); setDuration(event.target.getDuration() || 0); if (current.currentTime > 0) event.target.seekTo(current.currentTime, true); if (current.playing) event.target.playVideo(); },
        onStateChange: (event: any) => { if (event.data === 1) setDuration(event.target.getDuration() || 0); }
      } });
    };
    if (window.YT?.Player) makePlayer();
    else {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { previous?.(); makePlayer(); };
      if (!document.querySelector('script[data-youtube-api]')) { const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.dataset.youtubeApi = 'true'; document.head.appendChild(script); }
    }
    return () => { alive = false; try { player.current?.destroy(); } catch { /* player may not have finished loading */ } player.current = null; };
  }, []);
  useEffect(() => {
    const p = player.current; if (!p?.getVideoData) return;
    if (p.getVideoData()?.video_id !== playback.videoId) p.cueVideoById(playback.videoId);
  }, [playback.videoId]);
  useEffect(() => {
    const p = player.current; if (!p?.getPlayerState) return;
    if (playback.playing && p.getPlayerState() !== 1) p.playVideo();
    if (!playback.playing && p.getPlayerState() === 1) p.pauseVideo();
    if (playback.currentTime !== undefined && Math.abs((p.getCurrentTime?.() || 0) - playback.currentTime) > 2.5) p.seekTo(playback.currentTime, true);
  }, [playback.videoId, playback.playing, playback.updatedAt]);
  useEffect(() => { const timer = window.setInterval(() => { const p = player.current; if (p?.getCurrentTime) setProgress(p.getCurrentTime() || 0); }, 500); return () => clearInterval(timer); }, []);
  useEffect(() => { const timer = window.setInterval(() => { const p = player.current; if (isHost && playback.playing && p?.getCurrentTime) socket.emit('sync_position', { time: p.getCurrentTime() || 0 }); }, 3000); return () => clearInterval(timer); }, [isHost, playback.playing]);
  const toggle = () => { if (!canControl) return; const p = player.current; onAction(playback.playing ? 'pause' : 'play', playback.playing && p?.getCurrentTime ? { time: p.getCurrentTime() || 0 } : {}); };
  const seek = (e: React.ChangeEvent<HTMLInputElement>) => { if (canControl) onAction('seek', { time: Number(e.target.value) }); };
  return <div className="player-shell">
    <div className="player-screen"><div ref={frame} className="youtube-frame" />
      {!playback.playing && <button aria-label="Play video" className="big-play" onClick={toggle} disabled={!canControl}><Play size={26} fill="currentColor" /></button>}
      {!canControl && <div className="watch-only"><ShieldCheck size={15} /> You’re watching together</div>}
      <div className="player-controls"><button aria-label={playback.playing ? 'Pause' : 'Play'} disabled={!canControl} onClick={toggle}>{playback.playing ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button>
        <span className="player-time">{formatTime(progress)} <span>/</span> {formatTime(duration)}</span>
        <input aria-label="Seek video" type="range" min={0} max={Math.max(duration, 1)} value={Math.min(progress, duration || progress)} disabled={!canControl} onChange={seek}/>
        <button aria-label="Toggle mute" onClick={() => { const p = player.current; if (!p) return; if (muted) p.unMute(); else p.mute(); setMuted(!muted); }}>{muted ? <Headphones size={17}/> : <Volume2 size={17}/>}</button>
        <a aria-label="Open on YouTube" href={`https://www.youtube.com/watch?v=${playback.videoId}`} target="_blank" rel="noreferrer"><ExternalLink size={16}/></a>
      </div>
    </div>
  </div>;
}
function formatTime(time: number) { if (!Number.isFinite(time)) return '0:00'; const seconds = Math.floor(time); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [userId, setUserId] = useState('');
  const [mode, setMode] = useState<'create' | 'join'>(() => new URLSearchParams(location.search).has('room') ? 'join' : 'create'); const [name, setName] = useState(localStorage.getItem('watchparty-name') || '');
  const [roomName, setRoomName] = useState(''); const [roomCode, setRoomCode] = useState(new URLSearchParams(location.search).get('room') || '');
  const [videoInput, setVideoInput] = useState(''); const [chatText, setChatText] = useState(''); const [activeTab, setActiveTab] = useState<'chat' | 'people'>('chat');
  const [busy, setBusy] = useState(false); const [errorText, setErrorText] = useState(''); const [toast, setToast] = useState(''); const [copied, setCopied] = useState(false);
  const [openMenu, setOpenMenu] = useState(''); const [requestAction, setRequestAction] = useState(''); const [requestTime, setRequestTime] = useState('');
  const chatEnd = useRef<HTMLDivElement>(null);
  const self = useMemo(() => snapshot?.participants.find((p) => p.id === userId), [snapshot, userId]);
  const canControl = self?.role === 'host' || self?.role === 'moderator';
  const isHost = self?.role === 'host';

  const playSoundlessToast = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2600); }, []);
  useEffect(() => {
    const handlers = {
      room_snapshot: (data: Snapshot) => setSnapshot(data),
      playback_update: (data: Playback) => setSnapshot((s) => s ? { ...s, playback: data } : s),
      chat_message: (message: ChatMessage) => setSnapshot((s) => s ? { ...s, chat: [...s.chat, message].slice(-100) } : s),
      error_message: ({ message }: { message: string }) => { setErrorText(message); playSoundlessToast(message); },
      user_joined: ({ username }: { username: string }) => playSoundlessToast(`${username} joined the party`),
      user_left: ({ username }: { username: string }) => playSoundlessToast(`${username} left the party`),
      removed_from_room: () => { setSnapshot(null); setUserId(''); history.replaceState({}, '', '/'); setErrorText('The host removed you from this room.'); },
    };
    Object.entries(handlers).forEach(([event, handler]) => socket.on(event, handler as (...args: any[]) => void));
    if (location.pathname === '/room') setRoomCode(new URLSearchParams(location.search).get('room') || '');
    return () => { Object.entries(handlers).forEach(([event, handler]) => socket.off(event, handler as (...args: any[]) => void)); };
  }, [playSoundlessToast]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [snapshot?.chat.length, activeTab]);

  const enterRoom = (event: FormEvent) => {
    event.preventDefault(); setErrorText(''); setBusy(true); localStorage.setItem('watchparty-name', name.trim());
    if (!socket.connected) socket.connect();
    const action = mode === 'create' ? 'create_room' : 'join_room';
    const data = mode === 'create' ? { username: name, roomName, ...(getVideoId(videoInput) ? { videoId: getVideoId(videoInput) } : {}) } : { username: name, roomId: roomCode };
    socket.emit(action, data, (result: Ack) => {
      setBusy(false); if (!result.ok || !result.snapshot || !result.userId) { setErrorText(result.message || 'Could not enter the room.'); return; }
      setUserId(result.userId); setSnapshot(result.snapshot); history.replaceState({}, '', `/room?room=${result.snapshot.roomId}`);
    });
  };
  const leaveRoom = () => { socket.emit('leave_room'); socket.disconnect(); setSnapshot(null); setUserId(''); history.replaceState({}, '', '/'); };
  const sendAction = (action: string, payload: Record<string, number | string> = {}) => {
    if (!canControl) { playSoundlessToast('Ask the host or a moderator to make that change.'); return; }
    socket.emit('playback_action', { action, ...payload });
  };
  const changeVideo = (event: FormEvent) => { event.preventDefault(); const videoId = getVideoId(videoInput); if (!videoId) return playSoundlessToast('Paste a YouTube link or 11 character video ID.'); sendAction('change_video', { videoId }); setVideoInput(''); };
  const shareRoom = async () => { const url = `${location.origin}/?room=${snapshot?.roomId}`; try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setRoomCode(snapshot?.roomId || ''); playSoundlessToast(`Room code: ${snapshot?.roomId}`); } };
  const sendChat = (event: FormEvent) => { event.preventDefault(); if (!chatText.trim()) return; socket.emit('chat_message', { text: chatText }); setChatText(''); };
  const doRequest = () => { const data: any = { action: requestAction }; if (requestAction === 'seek') data.time = Number(requestTime); if (requestAction === 'change_video') { const videoId = getVideoId(videoInput); if (!videoId) return playSoundlessToast('Paste a YouTube link first.'); data.videoId = videoId; setVideoInput(''); } socket.emit('request_action', data, (result: Ack) => { if (result.ok) playSoundlessToast('Request sent to the host and moderators'); else playSoundlessToast(result.message || 'Could not send request'); }); };
  const manage = (event: string, payload: object) => socket.emit(event, payload, (result: Ack) => { if (!result?.ok) playSoundlessToast(result?.message || 'That action could not be completed.'); else setOpenMenu(''); });

  if (!snapshot) return <main className="landing">
    <nav className="topbar"><a className="brand" href="/"><span className="brand-mark"><Play size={16} fill="currentColor"/></span><span>reel<span className="brand-light">together</span></span></a><div className="nav-right"><span className="live-dot"/> <span>your people, in sync</span></div></nav>
    <section className="hero"><div className="hero-copy"><div className="eyebrow"><span className="sparkle"><Sparkles size={13}/></span> THE GROUP CHAT, BUT BETTER</div><h1>Same room.<br/><em>Same moment.</em></h1><p className="hero-desc">Pick a video, invite your people, and press play together. The couch is optional.</p>
      <div className="feature-row"><span><Radio size={15}/> In perfect sync</span><span><ShieldCheck size={15}/> Your room, your rules</span></div>
      <div className="join-card"><div className="mode-tabs"><button className={mode === 'create' ? 'active' : ''} onClick={() => { setMode('create'); setErrorText(''); }}>Start a room</button><button className={mode === 'join' ? 'active' : ''} onClick={() => { setMode('join'); setErrorText(''); }}>Join a room</button></div>
        <form onSubmit={enterRoom} className="entry-form"><label>Your name</label><input required maxLength={32} placeholder="What should we call you?" value={name} onChange={(e) => setName(e.target.value)}/>
          {mode === 'create' ? <><label>Room name <span className="optional">OPTIONAL</span></label><input maxLength={48} placeholder="Friday night movie club" value={roomName} onChange={(e) => setRoomName(e.target.value)}/><label>YouTube video <span className="optional">OPTIONAL</span></label><div className="input-icon"><Clapperboard size={17}/><input placeholder="Paste a video link to start" value={videoInput} onChange={(e) => setVideoInput(e.target.value)}/></div></> : <><label>Room code</label><input required maxLength={12} placeholder="e.g. A7K2QF" value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())}/></>}
          {errorText && <div className="form-error">{errorText}</div>}<button disabled={busy || !name.trim()} className="primary-btn">{busy ? <LoaderCircle className="spin" size={17}/> : mode === 'create' ? <><Plus size={17}/> Create your room <ArrowRight size={17}/></> : <>Join the watch party <ArrowRight size={17}/></>}</button>
        </form><p className="no-account"><Shield size={13}/> No account needed. Just show up.</p>
      </div>
      <div className="fine-note"><span>✦</span> Made for the “have you seen this?” moments</div>
    </div>
    <div className="hero-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-glow"/><div className="art-stamp stamp-one"><span className="mini-avatar avatar-lav">M</span><span><b>Maya</b><small>joined the room</small></span></div><div className="art-stamp stamp-two"><span className="mini-avatar avatar-peach">J</span><span><b>Jules</b><small>is watching</small></span></div><div className="art-card"><div className="art-video"><div className="mountain m-back"/><div className="mountain m-front"/><div className="sun"/><div className="art-player"><span/><span/><span/></div><div className="art-control"><Play size={18} fill="currentColor"/></div></div><div className="art-under"><span className="art-meta"><span className="live-pill"/> YOUR ROOM <b>·</b> 3 WATCHING</span><div className="avatar-stack"><span className="mini-avatar avatar-lav">M</span><span className="mini-avatar avatar-peach">J</span><span className="mini-avatar avatar-mint">Y</span></div></div></div><div className="art-note"><Music2 size={15}/> one play button. everybody’s there.</div></div>
    </section>
    <footer className="landing-footer"><span>REELTOGETHER © 2026</span><span>A little closer, from wherever you are <span className="footer-heart">♥</span></span></footer>
  </main>;

  const ownRequests = snapshot.requests.filter((request) => request.userId === userId);
  return <main className="app-shell"><header className="room-topbar"><a className="brand" href="/" onClick={(e) => { e.preventDefault(); leaveRoom(); }}><span className="brand-mark"><Play size={16} fill="currentColor"/></span><span>reel<span className="brand-light">together</span></span></a><div className="room-title"><span className="room-live"><i/> LIVE ROOM</span><b>{snapshot.roomName}</b><span className="title-divider"/><span className="code-label">{snapshot.roomId}</span></div><div className="room-actions"><div className="avatar-stack top-avatars">{snapshot.participants.slice(0, 4).map((person, i) => <span key={person.id} title={person.username} className={`mini-avatar color-${i % 4}`}>{initials(person.username)}</span>)}</div><span className="people-count"><Users size={15}/> {snapshot.participants.length}</span><button className="share-btn" onClick={shareRoom}>{copied ? <Check size={15}/> : <Link2 size={15}/>} {copied ? 'Copied!' : 'Invite'}</button><button className="icon-btn" title="Leave room" onClick={leaveRoom}><ArrowDownLeft size={18}/></button></div></header>
    <div className="room-content"><section className="watch-column"><div className="watch-heading"><div><div className="eyebrow small-eyebrow"><span className="live-dot"/> WATCHING TOGETHER</div><h1>The watch room<span className="heading-period">.</span></h1></div><div className="sync-badge"><span className="sync-bars"><i/><i/><i/><i/></span> SYNCED</div></div>
      <YouTubePlayer playback={snapshot.playback} canControl={!!canControl} isHost={!!isHost} onAction={sendAction}/>
      <div className="video-details"><div className="video-icon"><Clapperboard size={19}/></div><div className="video-title"><b>{snapshot.playback.videoId === 'jfKfPfyJRdk' ? 'lofi hip hop radio 📚 - beats to relax / study to' : 'Now playing on YouTube'}</b><span>Playing in sync for everyone in the room</span></div><span className="video-tag"><span className="live-dot"/> TOGETHER</span></div>
      {canControl ? <form className="change-video" onSubmit={changeVideo}><Clapperboard size={16}/><input placeholder="Paste a YouTube link to change what’s playing" value={videoInput} onChange={(e) => setVideoInput(e.target.value)}/><button type="submit" disabled={!videoInput.trim()}>Play this <ArrowRight size={15}/></button></form> : <div className="request-bar"><span><Shield size={16}/><b>Watching mode</b><small>Ask the host to make a change</small></span><div className="request-controls"><select value={requestAction} onChange={(e) => setRequestAction(e.target.value)}><option value="">Request an action…</option><option value="play">Play</option><option value="pause">Pause</option><option value="seek">Seek</option><option value="change_video">Change video</option></select>{requestAction === 'seek' && <input type="number" min="0" placeholder="Seconds" value={requestTime} onChange={(e) => setRequestTime(e.target.value)}/>}<button disabled={!requestAction} onClick={doRequest}>Ask <ArrowRight size={14}/></button></div></div>}
      {ownRequests.length > 0 && <div className="pending-self"><LoaderCircle size={14}/> {ownRequests.length} request{ownRequests.length > 1 ? 's' : ''} waiting for approval</div>}
      <div className="room-footnote"><Sparkles size={14}/> Little reminder: good videos are better with good company.</div>
    </section>
    <aside className="side-panel"><div className="side-tabs"><button className={activeTab === 'chat' ? 'selected' : ''} onClick={() => setActiveTab('chat')}><MessageCircle size={16}/> Chat {snapshot.chat.length > 0 && <span className="tab-count">{snapshot.chat.length}</span>}</button><button className={activeTab === 'people' ? 'selected' : ''} onClick={() => setActiveTab('people')}><Users size={16}/> People <span className="tab-count">{snapshot.participants.length}</span></button></div>
      {activeTab === 'chat' ? <><div className="chat-intro"><span className="chat-spark"><Sparkles size={13}/></span><b>Room chat</b><span>·</span><small>say hi, send a thought</small></div><div className="chat-list">{snapshot.chat.length === 0 ? <div className="empty-chat"><span className="empty-chat-icon"><MessageCircle size={20}/></span><b>It’s a little quiet in here.</b><span>Start the conversation with your crew.</span></div> : snapshot.chat.map((message) => <div className={`message ${message.username === self?.username ? 'mine' : ''}`} key={message.id}><div className={`chat-avatar color-${snapshot.participants.findIndex((p) => p.username === message.username) % 4}`}>{initials(message.username)}</div><div className="message-main"><div className="message-meta"><b>{message.username}</b>{message.role === 'host' && <Crown size={12} className="crown"/>}<time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p>{message.text}</p></div></div>)}<div ref={chatEnd}/></div><form className="chat-form" onSubmit={sendChat}><input maxLength={500} placeholder="Send a message…" value={chatText} onChange={(e) => setChatText(e.target.value)}/><button disabled={!chatText.trim()} aria-label="Send message"><Send size={16}/></button><span className="chat-hint">Enter to send</span></form></> : <><div className="people-heading"><span>{snapshot.participants.length} {snapshot.participants.length === 1 ? 'person' : 'people'} in this room</span><span className="live-text"><i/> HERE NOW</span></div><div className="people-list">{snapshot.participants.map((person, i) => <div className="person-row" key={person.id}><span className={`person-avatar color-${i % 4}`}>{initials(person.username)}<i/></span><span className="person-name"><b>{person.username}{person.id === userId && <small> (you)</small>}</b><span>{person.role === 'host' ? <><Crown size={12}/> Host</> : person.role === 'moderator' ? <><ShieldCheck size={12}/> Moderator</> : <><Headphones size={12}/> Participant</>}</span></span>{isHost && person.id !== userId && <div className="person-menu-wrap"><button className="person-menu" onClick={() => setOpenMenu(openMenu === person.id ? '' : person.id)} aria-label={`Manage ${person.username}`}><MoreHorizontal size={18}/></button>{openMenu === person.id && <div className="person-menu-pop"><button onClick={() => manage('assign_role', { userId: person.id, role: person.role === 'moderator' ? 'participant' : 'moderator' })}><ShieldCheck size={14}/>{person.role === 'moderator' ? 'Make participant' : 'Make moderator'}</button><button onClick={() => manage('transfer_host', { userId: person.id })}><Crown size={14}/>Transfer host</button><button className="danger-item" onClick={() => manage('remove_participant', { userId: person.id })}><X size={14}/>Remove from room</button></div>}</div>}</div>)}</div>{isHost && <div className="host-note"><ShieldCheck size={16}/><span><b>You’re the host</b><small>You can change the video, manage roles, and keep things in sync.</small></span></div>}
      {canControl && snapshot.requests.length > 0 && <div className="requests-section"><div className="requests-heading"><b>NEEDS YOUR OK</b><span>{snapshot.requests.length}</span></div>{snapshot.requests.map((request) => <div className="approval-card" key={request.id}><p><b>{request.username}</b> asked to <strong>{request.action === 'change_video' ? 'change the video' : request.action === 'seek' ? `seek to ${formatTime(request.time || 0)}` : request.action}</strong></p><div><button onClick={() => manage('review_request', { requestId: request.id, approve: true })}><Check size={13}/> Allow</button><button className="decline" onClick={() => manage('review_request', { requestId: request.id, approve: false })}>Decline</button></div></div>)}</div>}
    </>}
      <div className="panel-bottom"><span><span className="live-dot"/> ROOM’S FEELING GOOD</span><CircleHelp size={15}/></div>
    </aside></div>
    {toast && <div className="toast"><CheckCheck size={16}/>{toast}</div>}
  </main>;
}
