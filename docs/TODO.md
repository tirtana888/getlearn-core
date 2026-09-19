# getlearn TODO

Diperbarui 2026-09-19. Status: Frappe (Nusadaya) sudah live. Sisanya di bawah.

Prinsip yang berlaku untuk semua konektor: **getlearn yang menyesuaikan diri dengan LMS.** Data ditarik lewat API baca LMS dengan
kunci dari admin klien; tidak ada logika bisnis di LMS. Satu-satunya kode di sisi LMS adalah proxy chat + widget, karena kunci getlearn
tidak boleh sampai ke browser siswa dan getlearn tidak bisa memeriksa login LMS sendiri.

---

## 1. Konektor LMS baru

Riset dari dokumentasi resmi (Sep 2026). **[V]** = terkonfirmasi di dokumentasi, **[?]** = belum terkonfirmasi, harus diuji di situs uji.

### 1a. Tutor LMS (WordPress)

- Akses: Tutor LMS -> Tools -> REST API, pasangan key + secret, dipakai sebagai Basic Auth. Alamat `/wp-json/tutor/v1/`. Hanya baca. **[V]**
- Gratis **[V]**: `/courses`, `/courses/{id}`, `/course-contents/{id}`, `/topics?course_id=`, `/lessons?topic_id=`, `/quiz/{topic-id}`,
  `/quiz-question-answer/{quiz-id}`, `/course-annoucement/{id}`, `/course-rating/{id}`, `/author-information/{id}`.
- Pro **[V]** (v2.7.0): percobaan quiz (`/quiz-attempts?quiz_id=&student_id=`), daftar siswa terdaftar (`/enrollments?course_id=`),
  enrolled courses, dashboard siswa, kalender (termasuk jadwal tugas).
- Drip: add-on Content Drip (Pro), 4 mode per item (lesson/quiz/tugas): tanggal tertentu, hari setelah enrolment, berurutan, prasyarat. **[V]**
- Hook PHP (cadangan, butuh plugin): `tutor_quiz/attempt_ended`, `tutor_quiz_finished`, `tutor_mark_lesson_complete_after`, `tutor_after_enroll`. **[V]**
- SCORM: tidak bawaan; via plugin pihak ketiga (GrassBlade xAPI Companion). **[V]**

Celah (uji di situs uji sebelum janji apa pun):
- [ ] **[?]** Progres lesson per siswa lewat REST: tidak terlihat di endpoint mana pun yang terbaca. Ini data terpenting untuk rekomendasi.
- [ ] **[?]** Status/nilai pengumpulan tugas per siswa (yang terlihat hanya unggah lampiran).
- [ ] **[?]** Apakah aturan drip tiap item bisa dibaca lewat API.
- [ ] Daftar lengkap endpoint Pro (halaman dokumentasinya dirender JS, tidak terbaca utuh).

Keputusan model: di Tutor **quiz sejajar dengan lesson** di dalam Topic (bukan bagian lesson). Pilih: tautkan quiz ke lesson sebelumnya dalam topic
yang sama, atau jadikan **topic** satuan penguasaan.

Risiko: endpoint kunci ada di Pro (klien butuh lisensi); ekosistem WordPress bervariasi (tema, plugin, hosting).

### 1b. LearnDash (WordPress)

- Akses: REST WordPress, dasar `/wp-json/ldlms/v2/`. Dokumentasi menyebut nonce dan cookie; Application Passwords (Basic Auth, WP 5.6+) adalah mekanisme
  WordPress standar, **belum** dinyatakan dokumentasi LearnDash. Sebagian besar endpoint butuh hak admin. Status **v2: beta**.
- Data **[V]**: courses, lessons, topics, quizzes, questions, assignments (filter approved / not approved), essays, users <-> courses,
  **course progress per user**, **quiz progress & statistics**, groups, group leaders, course prerequisites.
- Filter waktu **[V]**: `modified_after`, `after`, `before`, plus `page`, `per_page` -> sinkronisasi bertahap dengan watermark seperti Frappe.
- Drip **[V]**, bawaan: per lesson, 3 mode (langsung / X hari setelah enrolment / tanggal tertentu), plus prasyarat dan progres linear.
- Hook PHP (cadangan): `learndash_quiz_completed`, `learndash_lesson_completed`, `learndash_course_completed`. **[V]**
- SCORM: tidak bawaan; plugin (Tin Canny / GrassBlade). **[V]**
- Hierarki Course -> Lesson -> Topic -> Quiz; quiz bisa menempel ke course/lesson/topic, jadi cocok dengan "lesson = satuan penguasaan".
- LearnDash **berbayar penuh**: situs uji butuh lisensi (dari user).

Celah:
- [ ] **[?]** Nama field drip di REST (mis. `visible_after`). Ambil skemanya dari situs uji: `GET /wp-json/learndash/v1/docs/openapi`.
- [ ] **[?]** Nilai tugas angka atau hanya status disetujui.
- [ ] **[?]** Kestabilan v2 (beta): parameter bisa berubah.

### 1c. Moodle

- Akses: Web Services bawaan. Admin mengaktifkan web service + protokol REST, membuat external service berisi fungsi yang diizinkan, lalu token.
  `.../webservice/rest/server.php?wstoken=...&wsfunction=...&moodlewsrestformat=json`. Token = kata sandi; wajib HTTPS, pakai POST. **[V]**
- Fungsi **[V]** (nama dari daftar resmi):
  - siswa: `core_enrol_get_enrolled_users`, `core_enrol_get_users_courses`
  - isi course: `core_course_get_contents` (bagian, aktivitas, URL file), `core_course_get_courses`
  - progres: `core_completion_get_activities_completion_status`, `core_completion_get_course_completion_status`
  - quiz: `mod_quiz_get_user_attempts`, `mod_quiz_get_attempt_review`, `mod_quiz_get_user_best_grade`
  - tugas: `mod_assign_get_submissions`, `mod_assign_get_grades`, `mod_assign_get_submission_status` (**nilai berupa angka**)
  - buku nilai: `gradereport_user_get_grade_items`, `core_grades_get_grades`
  - kalender: `core_calendar_get_calendar_events`, `core_calendar_get_action_events_by_course`
  - SCORM: `mod_scorm_get_scorms_by_courses`, `mod_scorm_get_scorm_sco_tracks`
- SCORM **bawaan**; file paket bisa diunduh dengan token dari `core_course_get_contents` -> ekstraksi SCORM yang sudah ada bisa dipakai ulang.
- "Restrict access" (setara drip) pada bagian dan aktivitas: tanggal (dari/sampai), penyelesaian aktivitas, nilai, grup/grouping, bidang profil. **[V]**
- Gratis dan terbuka; situs uji gratis (Docker).

Celah dan kerumitan:
- [ ] **[?]** Kondisi akses tersimpan sebagai JSON; `core_course_get_contents` memberi `availabilityinfo` (**teks HTML** alasan terkunci) dan dievaluasi untuk
  **pemilik token (admin), bukan tiap siswa**. Belum terkonfirmasi apakah JSON mentah bisa dibaca lewat web service. Versi awal: dukung syarat
  **tanggal + penyelesaian**.
- [ ] **Skala:** progres dan quiz diambil **per siswa per course**, tanpa filter "berubah sejak". Untuk 1.000 siswa x 5 course = ribuan permintaan per siklus.
  Gunakan buku nilai (banyak siswa per panggilan), polling bergilir / hanya siswa yang baru aktif.
- [ ] Fragmentasi versi (3.x - 5.x): ketersediaan fungsi berbeda. Periksa per versi.

Keputusan model: Course -> Bagian -> Aktivitas (quiz, tugas, SCORM, halaman...). Tidak ada "lesson" pembungkus. Pilih satuan penguasaan: **aktivitas** atau **bagian**.

AI bawaan Moodle (subsistem AI, 4.5+): **generik.** Aksi hanya menerima `contextid`, `userid`, `prompttext` (+ parameter aksi); dokumentasi tidak menyebut akses
ke progres/nilai. Plugin pihak ketiga yang mengklaim personal (belum diverifikasi kedalamannya): Exabis AI Chat Block (data buku nilai sebagai variabel prompt),
Alphabees AI Tutor (profil siswa menetap), Tutor AI (`local_dttutor`), LearnWise.
- [ ] Bandingkan langsung di situs uji: AI bawaan + 1-2 plugin pesaing vs coach getlearn, dengan pertanyaan yang sama. Cari tahu di mana kita unggul.

### Urutan yang disarankan
Frappe (selesai) -> **Moodle** (bila calon klien institusi/SCORM) atau **LearnDash** (bila bisnis kursus WordPress) -> Tutor.
Alasan: Moodle dan LearnDash sudah punya progres per siswa lewat API; Tutor masih punya celah di situ. **Perlu keputusan user:** siapa calon klien nyata berikutnya?

---

## 2. Pekerjaan bersama (sebelum konektor pertama selain Frappe)

- [ ] **Antarmuka adapter LMS.** Sekarang logika Frappe menyatu di `frappeSync.service.ts` / `frappeCatalog.service.ts`. Pisahkan kontrak kanonik (roster, katalog, progres,
  percobaan quiz, tugas, jadwal) dari implementasi per LMS.
- [ ] **Sinkronisasi toleran field.** Frappe standar (bukan fork Nusadaya) kemungkinan tidak punya field drip/jadwal tugas -> permintaan ditolak dan sinkronisasi gagal
  total. Tanyakan field yang tersedia lalu tarik yang ada.
- [ ] **Widget chat mandiri** (tanpa framework, dilayani dari getlearn) yang dipakai plugin WordPress, plugin Moodle, dan nanti aplikasi Frappe. Widget Vue saat ini
  hanya jalan di dalam Frappe.
- [ ] **Cara mengenali siswa harus identik di dua sisi** (penarik data dan proxy). Frappe: hash email. WordPress: sebaiknya ID pengguna (email tidak selalu terbaca).
- [ ] **Pengaturan per tenant:** zona waktu (sekarang tertanam Asia/Jakarta), bahasa prompt (Indonesia), warna merek, URL default.
- [ ] **Situs uji** per LMS: WordPress + Tutor (Free + Pro), WordPress + LearnDash (butuh lisensi dari user), Moodle (Docker, gratis).

### Plugin chat (kode sisi LMS, tipis, tanpa logika LMS)
- [ ] **WordPress** (satu plugin untuk LearnDash dan Tutor): halaman pengaturan (URL + kunci + aktif), jalur proxy (mulai/lanjutkan percakapan, kirim pesan) memakai pengguna yang login,
  pasang widget di halaman lesson.
- [ ] **Moodle** (plugin `local`): sisipkan widget lewat callback `before_footer`, proxy dengan siswa yang login. Alternatif tanpa kode di Moodle: **LTI 1.3** external tool
  (muncul sebagai aktivitas yang ditambah guru per course, bukan widget melayang; tidak tahu lesson mana yang dibuka).
- [ ] **Frappe:** pindahkan proxy + widget dari fork Nusadaya ke **aplikasi Frappe kecil** (`bench get-app`) agar klien Frappe standar bisa memakainya dan fork kembali bersih.

---

## 3. Masih terbuka dari pekerjaan sebelumnya (bukan konektor)

- [ ] **Keamanan (prioritas):** endpoint `/v1/admin/*` dan `/superadmin` tidak punya autentikasi. Harus ditutup sebelum klien kedua.
- [ ] Kunci Gemini dengan billing aktif (gratis = 20 permintaan/hari; sekarang DeepSeek yang menjawab hampir semuanya).
- [ ] Sembunyikan widget chat untuk pengguna yang bukan siswa terdaftar (guru/admin sekarang melihat pesan "profil belum siap").
- [ ] Tombol jempol 👍/👎 di widget (endpoint `POST /v1/chat/messages/:id/feedback` sudah ada; butuh metode proxy + deploy Frappe).
- [ ] Ganti kunci Frappe superadmin dengan user khusus baca-saja; buat tenant produksi resmi (sekarang `__verify_env_test_2__`) dengan kunci baru.
- [ ] Hapus data uji di tenant Nusadaya: `test_lesson_1`, soal `q_test_1`, `test_learner_1`.
- [ ] Uji SCORM dan chat dengan akun siswa biasa (semua uji sejauh ini memakai akun admin/founder).
- [ ] Uji beban dengan banyak siswa; batas 20 pertanyaan / 10 menit / siswa sudah ada.
- [ ] Postgres RLS untuk isolasi antar-tenant (saat ini isolasi di lapisan aplikasi).

---

## Sumber riset
- Tutor LMS: https://tutorlms.com/docs/rest-api-tutor-lms-free/ , https://tutorlms.com/blog/tutor-lms-update-v2-2-1/ , https://tutorlms.com/blog/tutor-lms-update-v2-7-0/ ,
  https://docs.themeum.com/tutor-lms/addons/content-drip/ , https://tutorlms.com/docs/developer-guides/action-hooks/
- LearnDash: https://developers.learndash.com/learndash-rest-api-ldlms-v2/ , https://developers.learndash.com/rest-api/v2/v2-user-quiz-progress/ ,
  https://developers.learndash.com/rest-api/v2/v2-assignments/ , https://learndash.com/support/kb/core/lessons/lesson-access-settings/
- Moodle: https://docs.moodle.org/dev/Web_service_API_functions , https://docs.moodle.org/dev/Availability_API , https://docs.moodle.org/502/en/Restrict_access ,
  https://docs.moodle.org/502/en/LTI_External_tools , https://moodledev.io/docs/5.0/apis/plugintypes/ai/placement , https://docs.moodle.org/502/en/AI_providers
