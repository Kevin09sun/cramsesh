import { SidebarToggle } from "@/components/sidebar";
import { StudyTimeView } from "@/components/study-time-view";
import { stores } from "@/src/server";

/**
 * /time — the Study time tracker (issue #16). One server read folds every
 * session's per-day log; `force-dynamic` keeps a navigation from serving a
 * stale calendar. The clock that writes those logs lives in the chat page
 * (components/study-clock.tsx).
 */

export const dynamic = "force-dynamic";

export default function StudyTimePage() {
	const days = stores.chatStore.studyTimeByDay();
	return (
		<div className="relative flex h-dvh flex-col">
			<header className="flex h-15 shrink-0 items-center gap-2 border-b border-border px-3">
				<SidebarToggle />
				<h1 className="font-title text-xl tracking-tight">Study time</h1>
			</header>
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-3xl px-6 py-8">
					<StudyTimeView days={days} today={new Date()} />
				</div>
			</main>
		</div>
	);
}