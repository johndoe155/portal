# Phase 4 — Frontend Component Tree & State Strategy

**Project:** High School Portal · **Status:** Proposed — awaiting approval · **Date:** 2026-10-01
**Builds on:** Phase 1 (stack), Phase 2 (schema), Phase 3 (API contract)

---

## 0. Topology decisions this phase resolves

| Problem | Resolution |
| --- | --- |
| Web (Vercel) and API (Railway) are different origins → third-party cookies/CORS | **Same-site subdomains + BFF rewrites.** `app.portal.example` (Vercel) rewrites `/api/v1/**` to `api.portal.example` over the private network; the `__Host-sid` cookie stays first-party, zero CORS on REST. |
| Socket.IO can't ride Vercel rewrites | **One-time WS ticket.** `POST /api/v1/realtime/ticket` (cookie-authed) → `{ticket}` (30 s, single-use, bound to session) → client opens `wss://api.portal.example/ws?ticket=…`. No cookie ever sent cross-origin. |
| RSC vs client data fetching | **RSC fetches via an internal service client** (shared-secret header, private network) for first paint; interactive screens use TanStack Query against the rewritten `/api/v1` base. One API, two consumers. |
| Calendar component | **Purpose-built month/week grid** (~300 LOC) instead of FullCalendar: our events are 3 typed sources from `v_student_calendar`; FullCalendar's 300 KB is not worth it. Recharts stays (lazy-loaded). |

---

## 1. Design system & shell

### 1.1 Principles
- **Mobile-first, thumb-zone IA**: bottom tab bar (≤5 tabs) on <768 px, sidebar on ≥1024 px; every primary action inside the thumb arc; 44 px minimum targets.
- **WCAG 2.2 AA**: contrast ≥4.5:1, focus-visible ring token on everything, skip links, landmarks per dashboard, `aria-live` for toasts/sync badges, status never conveyed by colour alone (icon+text), reduced-motion honoured, `axe-core` in CI + one screen-reader pass per dashboard per release.
- **Perf budget (CI-enforced)**: initial JS ≤150 KB gz per dashboard, LCP <2.5 s on Moto G4/3G (Lighthouse CI ≥90 mobile), no chart/image library on the critical path (dynamic imports), fonts via `next/font` (2 weights, `font-display: swap`), images via `next/image` + R2 remote pattern.
- **Offline reality**: attendance and grade entry must survive a dead classroom connection (§5).

### 1.2 Shell components (shared)
```
PortalShell
├─ TopBar          (school crest, RoleSwitcher, NotificationBell, offline badge, avatar menu)
├─ SideNav         (desktop ≥1024px; per-role items, badge counts)
├─ TabBar          (mobile; 5 slots incl. "More" sheet)
├─ CommandPalette  (Ctrl-K; staff only; jump to student/section)
├─ RealtimeBridge  (socket lifecycle, §4.3)
├─ ToastHost       (aria-live polite; success/warn/error + Undo where safe)
├─ SyncBadge       (offline queue depth; pulses while flushing)
└─ ErrorBoundary / RouteSkeleton / EmptyState / ConsentBanner(under-13)
```

### 1.3 Domain component library (`components/domain/`)
`DataTable` (TanStack Virtual; sticky header; column config persisted), `GradeCell` (inline edit, optimistic, revision popover), `AttendanceChip` (present/late/absent/excused — icon+colour+label), `RegisterGrid`, `BalanceCard`, `InvoiceTimeline`, `ThreadList/ThreadView`, `CalendarGrid` (month/week, 3-source), `ScheduleStrip`, `ReportCardViewer` (PDF + JSON snapshot), `UploadDropzone` (presign flow, progress, scan-pending state), `RevisionTimeline`, `AuditTable`, `ImportWizard`, `FeeGenerateWizard`, `StopEditor` (drag-order), `CommentBankPicker`.

---

## 2. Route map (Next.js 16 App Router)

```
app/
├─ proxy.ts                      # authN gate, role redirect, MFA step-up redirect
├─ (public)/
│  ├─ login/page.tsx             # IdP buttons + parent email; next= deep link
│  ├─ auth/callback/route.ts     # BFF code exchange → cookie → redirect by role
│  └─ invite/[token]/page.tsx    # parent onboarding challenge + account create
├─ (portal)/layout.tsx           # session load, PortalShell, RealtimeBridge, QueryClientProvider
│  ├─ (admin)/admin/
│  │  ├─ page.tsx                # dashboard
│  │  ├─ directory/page.tsx  ├─ directory/[userId]/page.tsx
│  │  ├─ enrollment/page.tsx ├─ academics/page.tsx
│  │  ├─ fees/page.tsx       ├─ transport/page.tsx
│  │  ├─ exams/page.tsx      ├─ communications/page.tsx
│  │  └─ compliance/page.tsx
│  ├─ (teacher)/teacher/
│  │  ├─ page.tsx (today)  ├─ attendance/[sectionId]/page.tsx
│  │  ├─ gradebook/[sectionId]/page.tsx
│  │  ├─ assignments/page.tsx ├─ assignments/[id]/page.tsx
│  │  ├─ messages/page.tsx ├─ messages/[conversationId]/page.tsx
│  │  └─ schedule/page.tsx
│  ├─ (student)/student/
│  │  ├─ page.tsx (today)  ├─ grades/page.tsx ├─ attendance/page.tsx
│  │  ├─ assignments/page.tsx ├─ calendar/page.tsx
│  │  ├─ fees/page.tsx ├─ exams/page.tsx └─ notifications/page.tsx
│  └─ (parent)/parent/
│     ├─ page.tsx (family) ├─ children/[id]/grades|attendance|fees|transport
│     ├─ messages/page.tsx ├─ calendar/page.tsx └─ notifications/page.tsx
```

`proxy.ts` rules: no session + portal path → `/login?next=`; staff without `mfa_verified` session → `/mfa/setup`; authenticated user on foreign-role route → 302 to active-role home (UX only; API+RLS remain the enforcement).

---

## 3. State management strategy

**Rule: the server owns truth; the client owns intent.** Four buckets, never mixed:

| Bucket | Tool | Contents |
| --- | --- | --- |
| Server state | **TanStack Query v5** | everything from `/api/v1` |
| UI state | **Zustand** | active term, parent's selected child, drawer/sheet state, table column config, palette recents |
| Form state | **React Hook Form + Zod** (shared `packages/contracts`) | every editor; server `problem+json` errors mapped onto fields |
| Offline intent | **Dexie (IndexedDB) + custom sync engine** | attendance registers, grade drafts (§5) |

No Redux; no global caches duplicating Query.

### 3.1 Query-key taxonomy & cache policy
```
['me']                                  stale 5m, retry on 401→redirect login
['dash', role]                          stale 30s, ETag/If-None-Match
['sections', termId]                    stale 5m
['section', id, 'roster']               stale 60s
['section', id, 'gradebook']            stale 30s
['section', id, 'attendance', date]     stale 10s
['student', id, 'grades'|'attendance'|'fees'|'transport']   stale 60s
['assignments', scope, tab]             stale 30s
['conversation', id, 'messages']        stale ∞ within session (append-only via WS)
['conversations', mine]                 stale 60s
['notifications', cursor]               stale 0 (bell accuracy)
['events', from, to] / ['announcements'] stale 60s
['report-cards', studentId]             stale ∞ (immutable versions)
['exam-period', id, 'exams']            stale 5m
['invoices', filter]                    stale 30s
```

### 3.2 Mutations & optimistic updates
`useMutation` per action with `onMutate` snapshot-rollback. Optimistic where latency hurts: `AttendanceChip` toggles, notification read, teacher message send, `GradeCell` edits (409 → rollback + toast with server state). Pessimistic where money/records move: invoice void, payment record, role changes, user suspend (button spinner + skeleton rows).

### 3.3 Realtime bridge (`hooks/use-realtime.ts`)
```
connect(wss + ticket) → on 'notification.created' etc.:
   EVENT_INVALIDATIONS: {kind → queryKeys[]}   (e.g. 'grade.released' → ['student',*, 'grades'], ['dash',*])
   kinds with toast → ToastHost; bell count refetch; 'message.created' → append to open thread only
on disconnect → backoff+jitter; on reconnect → GET /notifications?since= + invalidate ['dash']
```
Sockets never carry data (§Phase-3 §4) — a missed event degrades to a slightly stale cache, never to wrong data.

---

## 4. The four dashboards — component trees

### 4.1 ADMIN
```
AdminDashboardPage (RSC first paint; cards stream via Suspense)
├─ StatCardsRow        (enrolled, attendance-today %, fees-collected %, pending approvals)
├─ AlertsFeed          (overdue invoices >n, unsubmitted registers today, failed webhooks)
├─ QuickActions        (announce, generate invoices, import roster, new user)
└─ EnrollmentSparkline (lazy Recharts)

DirectoryPage
├─ FilterBar (role, status, grade, q)  ─ UserTable (virtual 5k rows)
│   └─ UserDrawer: ProfileTab · RolesTab · GuardiansTab · SessionsTab (revoke) · ConsentTab
├─ UserFormSheet · ImportWizard(3 steps) · RoleMatrixEditorPage

EnrollmentPage: SectionPicker → RosterTable → AddStudentsDialog (search+bulk) / DropDialog(reason)

AcademicsPage: YearTermTimeline · CourseTable · SectionTable
└─ SectionSheet: staff assign · meetings editor (weekly grid w/ teacher+room conflict warnings)

FeesPage: FeeItemCatalog · GenerateInvoicesWizard(term→scope→preview counts→job)
├─ InvoiceTable(status chips) → InvoiceDrawer(lines, allocations, void)
└─ RecordPaymentSheet (idempotent; gateway ref for reconciliation)

TransportPage: RouteTable → RouteSheet(StopEditor drag-order) · ManifestView(print/PDF)

ExamsPage: PeriodCards → ExamSchedulerGrid (date/room/teacher clash badges) → publish

CommsPage: CalendarAdminGrid (CRUD events, audience targeting) · AnnouncementComposer
           (audience + pin + expiry; publish → socket fan-out)

CompliancePage: AuditTable(filters, verify-chain button) · ExportsQueue · AmendmentsQueue · ConsentLedger
```

### 4.2 TEACHER (offline-first)
```
TeacherTodayPage
├─ PeriodTimeline (now-line; each card: section, room, register status chip, CTA)
├─ AbsentFollowUpList (yesterday's absentees → message-parent shortcut)
└─ UngradedQueue (submissions waiting > 48 h)

AttendanceRegisterPage [sectionId][date]            ← OFFLINE CAPABLE
├─ RegisterGrid (roster rows × AttendanceChip; bulk "all present"; search)
├─ SyncStatusHeader (saved-local n / synced / conflict n)
├─ ConflictBanner (server-wins list; teacher confirms)
└─ FinalizeBar (locks → absence notifications)

GradebookPage [sectionId]
├─ GradeGrid (virtual; columns=items; GradeCell inline edit; weight row editor)
├─ ReleaseButton (confirm → notify) · RevisionDrawer (per cell history)
└─ CommentBankPicker (for feedback cells)

AssignmentsPage → AssignmentComposerSheet (type, points, due, materials UploadDropzone)
AssignmentDetailPage: SubmissionsQueue → GradingPanel (viewer + points + feedback → grade)

MessagesPage: ThreadList(by student) → ThreadView (composer; parent-read indicators)

SchedulePage: ScheduleStrip(week) + room changes
```

### 4.3 STUDENT
```
StudentTodayPage
├─ TodayClassesStrip · DueThisWeekList · LatestGradesList · AnnouncementsCarousel

GradesPage: TermPicker → SectionCards (letter+pct, feedback link, revision note if changed)
AttendancePage: MonthHeatmap (icon-coded) + register list + absence notes
AssignmentsPage: Tabs(due | missing | graded) → SubmissionSheet (UploadDropzone, attempt #, late warning)
CalendarPage: CalendarGrid(events ∪ dues ∪ exams; type filters)
FeesPage: BalanceCard → InvoiceList → PayButton (gateway redirect; return-state banner)
ExamsPage: TimetableCards (date/room/countdown)
NotificationsPage: list + preference toggles + push enable prompt
```

### 4.4 PARENT (read-only, child-switcher first)
```
ParentFamilyPage
├─ ChildSwitcher (verified children; under-13 badge)
└─ ChildSummaryCards: TodayAttendance · Balance · NextDeadline · UnreadMessages
ChildGradesPage: released-only cards + ReportCardViewer (PDF download)
ChildAttendancePage: heatmap + list (same components as student, parent scope)
ChildFeesPage: BalanceCard · InvoiceTimeline · PayButton (initiate-only)
MessagesInboxPage: ThreadList → ThreadView (read-only; banner: "Replies via front office: …")
CalendarPage / NotificationsPage (+ per-child channel preferences)
```

### 4.5 Screen → endpoint → cache/realtime map (excerpt; full table ships with code)
| Screen | Primary endpoints | staleTime | Invalidated by |
| --- | --- | --- | --- |
| Teacher Today | `/teacher/today` | 30 s | `attendance.finalized` |
| Register | `/sections/{id}/attendance` | 10 s | local sync + WS |
| Gradebook | `/sections/{id}/gradebook`, `grades/bulk` | 30 s | `grade.released/changed` |
| Student Grades | `/student/grades` | 60 s | `grade.released` |
| Parent Family | `/parent/dashboard` (ETag) | 30 s | any child event |
| Fees (S/P) | `/student/fees`, `payments/intent` | 30 s | `fee.payment_received` |
| Messages | `/conversations…` | ∞+append | `message.created` |
| Calendar | `/student/calendar` or `/events` | 60 s | `event.changed`, `announcement.published` |

---

## 5. Offline attendance & grade-draft sync

1. Register UI writes to Dexie `outbox` **first** (instant chip), then tries `POST /sections/{id}/attendance` with `Idempotency-Key`.
2. Online: 200 → mark synced, Query cache updated from server response.
3. Offline/timeout: stays queued; `SyncBadge` shows depth; service-worker `online` event + visibility flush with backoff.
4. Conflict: server 200 with `conflicts:[{student, server_status, local_status}]` (someone else finalized) → **server wins**, ConflictBanner lists rows, teacher can re-apply intent as a new draft (audit-visible).
5. Grade drafts follow the same pattern minus finalize.
6. Nothing else is offline-writable in v1 (submissions need the presign round-trip; show a clear "needs connection" state).

---

## 6. PWA, push & install

- Serwist SW: precache shell, runtime-cache static assets, offline fallback page with queued-work summary.
- Web Push: permission prompt contextualised (after first absence notification or grade release — never on load); `POST /push/subscribe`; iOS requires installed PWA (banner copy explains add-to-home-screen).
- Install prompt: teacher/student on mobile get a dismissible banner; persisted dismissal in Zustand-persist.

---

## 7. `apps/web` structure

```
apps/web/
├─ app/            (route map §2)
├─ components/
│  ├─ ui/          (shadcn primitives, tokens)
│  ├─ shell/       (§1.2)
│  └─ domain/      (§1.3)
├─ lib/            (server-client, api-client, query-client, realtime, offline/, push, money/date fmt)
├─ hooks/          (use-realtime, use-offline, use-presign-upload, use-etag-fetch)
├─ stores/         (ui.ts, offline.ts)
└─ styles/         (tokens: colour/contrast-audited, spacing, radii, focus ring)
```

## 8. Testing & quality gates

- **Component**: Vitest + RTL for `GradeCell`, `AttendanceChip`, sync engine (fake IDB), money formatting.
- **E2E (Playwright)**, mobile viewports 360×800/390×844 first: login-per-role (SSO stubbed), teacher offline attendance → reconnect sync → parent notified, teacher releases grade → student+parent see, parent initiates pay (gateway sandbox), admin CSV import → roster appears, thread send/read.
- **A11y**: `axe` CI gate (0 violations AA), keyboard-only pass per dashboard.
- **Perf**: Lighthouse CI budgets (§1.1) fail the build on regression; bundlewatch on `components/domain`.
- **Visual**: screenshot diffs on the 4 dashboards at 2 breakpoints.

---

## 9. What this phase deliberately does NOT do

- No native mobile apps (PWA covers v1; FCM/APNs native later).
- No i18n beyond `preferred_language` plumbing (en shipped; strings via `next-intl`-ready keys).
- No theming/white-label per school (single school decision).
- No GraphQL client, no Redux, no CSS-in-JS.
