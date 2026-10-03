# ReelTogether

A small watch party app for watching YouTube videos at the same time. Create a room, share its invite link or short code, and watch together with host and moderator playback controls, participant approval requests, and room chat.

## Run locally

Requirements: Node.js 22.12 or newer and npm.

```sh
npm install
npm run dev
```

Open the Vite URL printed by the client process (usually `http://localhost:5173`). The Vite development server proxies API and Socket.IO traffic to Express on port 3001. For a production build, run `npm run build` followed by `npm start`; the Express server serves the built frontend and listens on `PORT` (3001 locally).

## Deploy on Render

`render.yaml` defines a single Node web service. Push this repository to a Git provider, then in Render choose **New → Blueprint** and connect that repository. Render reads the Blueprint, installs dependencies (including TypeScript and React type declarations) with `npm ci --include=dev`, builds with `npm run build`, starts with `npm start`, and checks `/api/health`. WebSockets use the same public service and origin as the frontend. No secret environment variables are required.

**Live URL:** Add the `https://<service-name>.onrender.com` URL shown by Render after the first successful deploy.

Render deployment still needs a connected Git repository and a Render account. This workspace has no configured Git remote or Render credentials, so a public service URL cannot be created from this checkout alone.

## How it works

- React and Vite render the landing page, YouTube IFrame API player, participant list, role controls, approval queue, and chat.
- Express serves the production build and a small health endpoint. Socket.IO runs on the same HTTP server and carries room events over WebSockets, with its built-in transport fallback if a network blocks WebSockets.
- The server owns an in-memory `Room` object for every active room. A room stores the participant roles, playback state, pending requests, and the latest 100 chat messages.
- On create, the server assigns the creator the `host` role. Joiners become `participant`. Only `host` and `moderator` can issue playback actions; only the host can change roles, remove participants, or transfer host. These checks happen on the server before any event is broadcast.
- Participants can request play, pause, seek, or a video change. The host or a moderator can approve or decline each request. Approval applies the action through the same server-side playback path as direct controls.
- The host and moderators send the current player position every three seconds during playback. Everyone receives the authoritative room state and corrects drift in the YouTube player.

## Events and permissions

The client emits `create_room`, `join_room`, `playback_action`, `assign_role`, `remove_participant`, `transfer_host`, `request_action`, `review_request`, and `chat_message`. The server responds with `room_snapshot`, `playback_update`, `user_joined`, `user_left`, and `error_message` broadcasts. Socket identity and room membership are recorded on the server connection, so clients cannot nominate their own role or user ID in a privileged action.

## Notes and trade-offs

- Room data lives in process memory. Rooms disappear when the last person leaves or the server restarts. This is suitable for a demo and a single Render instance; persistent storage and Redis-backed Socket.IO are needed for durable rooms or multiple server instances.
- The free Render plan may spin down when idle. Its first request can take longer while the service wakes.
- YouTube videos must allow embedding. Browsers may require a user gesture before playback with audio.
- There is no account system. Usernames are room-scoped labels, not verified identities; the room code should be shared only with invited people.

## Code map

- `src/App.tsx` — React screens, room interactions, YouTube player, and Socket.IO client events.
- `src/styles.css` — responsive visual design.
- `server/index.ts` — `Room` model, Socket.IO event handlers, Zod payload validation, role enforcement, and Express server.
- `render.yaml` — Render Blueprint deployment configuration.
