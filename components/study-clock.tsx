"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ClockIcon } from "lucide-react";

import { formatStudySpan, formatStudyTime, MAX_STUDY_CHUNK_MS, STUDY_FLUSH_MS, STUDY_IDLE_PAUSE_MS, studyDayKey } from "@/src/core";

/**
 * THE SESSION CLOCK (issue #16, owner-approved 2026-11-27).
 *
 * The owner's rule: time counts while the learner is IN a session. The clock
 * starts at the first prompt/upload of a visit (the chat page calls the
 * exposed start through `startRef`), runs only while the page is visible and
 * the window focused, pauses after two minutes without input, and stops when
 * the page is left. Counted milliseconds are flushed to the record every
 * fifteen seconds — and once more as the page hides or unmounts — so a
 * crash or a hard close loses at most a quarter minute.
 *
 * The write path is the record's per-day log (POST /api/chats/[id]/time);
 * the server merges chunks per LOCAL day, so the tracker's squares stay
 * exact. `initialMs` is the session's persisted total on page load.
 *
 * Lives in its OWN tiny component on purpose: the display ticks every
 * second, and Chat is far too big to re-render on a timer. Chat starts it
 * through a ref, so the ticking never reaches the parent.
 */

const TICK_MS = 1000;

/** Learner input that keeps the clock alive. Pointer movement counts — the
 *  learner reading a long answer with the mouse moving is still there. */
const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "scroll"] as const;

export function SessionClock({
	chatId,
	initialMs,
	startRef,
}: {
	chatId: string;
	/** The session's persisted total on page load. */
	initialMs: number;
	/** Chat hands its start trigger here; installed after mount (child
	 *  effects run before the parent's, so Chat's trigger effect finds it). */
	startRef?: RefObject<(() => void) | null>;
}) {
	// Displayed total = server-confirmed time + this visit's unflushed time.
	const [totalMs, setTotalMs] = useState(initialMs);
	const persistedRef = useRef(initialMs);
	const visitRef = useRef(0);
	/** Counted but not yet acknowledged — what the next flush sends. */
	const pendingRef = useRef(0);
	const armedRef = useRef(false);
	const lastActivityRef = useRef(0);
	const lastTickRef = useRef(0);
	const focusedRef = useRef(true);
	const flushInFlightRef = useRef(false);

	const syncDisplay = useCallback(() => {
		setTotalMs(persistedRef.current + visitRef.current);
	}, []);

	/** Arm the clock — the visit's first prompt/upload (idempotent). */
	const start = useCallback(() => {
		if (armedRef.current) return;
		armedRef.current = true;
		lastActivityRef.current = Date.now();
		lastTickRef.current = Date.now();
	}, []);

	if (startRef) startRef.current = start;

	// Install the trigger after mount (never during render). A child's
	// effects run before its parent's, so Chat's first-prompt effect below
	// always finds it.
	useEffect(() => {
		if (!startRef) return;
		startRef.current = start;
		return () => {
			startRef.current = null;
		};
	}, [startRef, start]);

	/** The awaitable flush: one chunk, serialized, re-anchored to the
	 *  server's total on success and restored to pending on failure. */
	const flush = useCallback(
		(keepalive = false) => {
			if (flushInFlightRef.current) return;
			const ms = Math.min(Math.floor(pendingRef.current), MAX_STUDY_CHUNK_MS);
			if (ms < TICK_MS) return;
			pendingRef.current -= ms;
			flushInFlightRef.current = true;
			void (async () => {
				try {
					const response = await fetch(`/api/chats/${chatId}/time`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ day: studyDayKey(new Date()), ms }),
						keepalive,
					});
					if (!response.ok) throw new Error(`time flush ${response.status}`);
					const payload = (await response.json().catch(() => null)) as { timeMs?: unknown } | null;
					if (typeof payload?.timeMs === "number") {
						persistedRef.current = payload.timeMs;
						visitRef.current = Math.max(0, visitRef.current - ms);
						syncDisplay();
					}
				} catch {
					pendingRef.current += ms; // retry on the next interval
				} finally {
					flushInFlightRef.current = false;
				}
			})();
		},
		[chatId, syncDisplay],
	);

	/** Leaving the page: fire the rest without waiting and without the
	 *  in-flight guard (a running flush already took its own share). */
	const flushOnLeave = useCallback(() => {
		const ms = Math.min(Math.floor(pendingRef.current), MAX_STUDY_CHUNK_MS);
		if (ms < TICK_MS) return;
		pendingRef.current -= ms;
		void fetch(`/api/chats/${chatId}/time`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ day: studyDayKey(new Date()), ms }),
			keepalive: true,
		}).catch(() => undefined);
	}, [chatId]);

	// Activity keeps the clock awake; visibility and focus pause it.
	useEffect(() => {
		const noteActivity = () => {
			if (armedRef.current) lastActivityRef.current = Date.now();
		};
		// Capture: a scroller inside the app doesn't bubble its scroll to
		// window, and reading a long answer is exactly that gesture.
		for (const name of ACTIVITY_EVENTS) window.addEventListener(name, noteActivity, { passive: true, capture: true });
		return () => {
			for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, noteActivity, { capture: true });
		};
	}, []);

	useEffect(() => {
		focusedRef.current = document.hasFocus();
		const onFocus = () => {
			focusedRef.current = true;
			lastActivityRef.current = Date.now();
			lastTickRef.current = Date.now();
		};
		const onBlur = () => {
			focusedRef.current = false;
			flush();
		};
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
		};
	}, [flush]);

	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				flush();
				return;
			}
			// Back in the tab: they are here again — but the hidden span is
			// not counted (the ticker reads visibility itself).
			lastActivityRef.current = Date.now();
			lastTickRef.current = Date.now();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [flush]);

	// The one-second counter. Delta is clamped to two ticks so a throttled
	// or hung tab can never bank a stretch it did not observe.
	useEffect(() => {
		const timer = setInterval(() => {
			if (!armedRef.current) return;
			const now = Date.now();
			const active =
				document.visibilityState === "visible" &&
				focusedRef.current &&
				now - lastActivityRef.current < STUDY_IDLE_PAUSE_MS;
			if (active) {
				const delta = Math.min(now - lastTickRef.current, TICK_MS * 2);
				visitRef.current += delta;
				pendingRef.current += delta;
				syncDisplay();
			}
			lastTickRef.current = now;
		}, TICK_MS);
		return () => clearInterval(timer);
	}, [syncDisplay]);

	// Periodic flush, plus the leave paths (unmount included — navigating to
	// another session must not strand the last quarter minute).
	useEffect(() => {
		const timer = setInterval(() => flush(), STUDY_FLUSH_MS);
		const onPageHide = () => flushOnLeave();
		window.addEventListener("pagehide", onPageHide);
		window.addEventListener("beforeunload", onPageHide);
		return () => {
			clearInterval(timer);
			window.removeEventListener("pagehide", onPageHide);
			window.removeEventListener("beforeunload", onPageHide);
			flushOnLeave();
		};
	}, [flush, flushOnLeave]);

	if (totalMs <= 0) return null;
	return (
		<span
			data-testid="session-time"
			role="timer"
			aria-label={`Study time in this session: ${formatStudySpan(totalMs)}`}
			title="Time counted in this session"
			className="flex shrink-0 items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
		>
			<ClockIcon className="size-3.5" aria-hidden />
			{formatStudyTime(totalMs)}
		</span>
	);
}