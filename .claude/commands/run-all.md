---
description: Nyalain Reel Fortune 3D lengkap (backend :8787 + client :8000) dan cek sehat
---

Nyalain Reel Fortune 3D lengkap di lokal:

1. Cek dulu port 8787 dan 8000 kosong (`lsof -ti:8787,8000`). Kalau ada yang nyangkut, kasih tahu aku PID-nya, jangan langsung kill.
2. Jalanin backend di background: `cd server && npm start` (default PORT=8787). `node_modules` udah ada, jangan `npm install` kecuali emang error missing module.
3. Jalanin static server buat client di background dari root repo: `python3 -m http.server 8000`.
4. Tunggu sampai dua-duanya siap, lalu verifikasi:
   - backend: curl endpoint health/root di http://localhost:8787
   - client: `curl -sI http://localhost:8000/index.html` harus 200
5. Buka http://localhost:8000 di browser.
6. Laporin ringkas: URL client, URL server, PID/log file masing-masing, cara matiinnya.

Catatan penting: client default-nya nembak ke origin-nya sendiri (:8000), padahal backend di :8787. Jadi ingetin aku buat set server URL ke `http://localhost:8787` lewat panel Social/Server di dalam game (atau `localStorage.setItem('rf-server','http://localhost:8787')` di devtools) supaya sign-in dan leaderboard nyambung.

Kalau ada step yang gagal, tampilin output errornya apa adanya, jangan diem-diem skip.
