@echo off
set PORT=8920
set ADMIN_PASSWORD=distillerie
set SESSION_SECRET=local-dev-only
set PUBLIC_BASE_URL=http://localhost:8920
npm install
npm start
