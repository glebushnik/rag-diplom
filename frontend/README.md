# Frontend Desktop MVP

Electron + React + TypeScript desktop UI for Gateway API.

## Implemented checklist
- Login/Register with JWT (`/api/v1/auth/register`, `/api/v1/auth/login`)
- JWT in memory + secure storage through Electron `main/preload`
- Source upload (`POST /api/v1/sources`) and status tracking with polling (`GET /api/v1/sources/{id}`)
- Course creation (`POST /api/v1/courses`)
- Course viewer (`GET /api/v1/courses/{id}`)
- Liquid Glass visual style (blur cards, gradients, soft animations)

## Run
```bash
cd frontend
npm install
GATEWAY_URL=http://localhost:8000 npm run dev
```

Notes:
- `GATEWAY_URL` is used by Electron preload.
- `VITE_GATEWAY_URL` is used as fallback in browser mode.

## Build
```bash
cd frontend
npm run build
```

## Docker (via root compose)
```bash
docker compose up --build
```
Open `http://localhost:3000`.

## Scripts
- `npm run dev` - Vite + Electron + electron TypeScript watcher
- `npm run typecheck` - TypeScript checks
- `npm run lint` - ESLint
- `npm run build` - build renderer + compile Electron main/preload

## DoD mapping
1. Upload document and wait for `indexed` status in Sources tab.
2. Build a course from indexed source in Course Builder tab.
3. See course structure in Course Viewer tab.
