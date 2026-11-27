import { formatStudySpan, studyCalendar, studyDayKey, studyLevel, studyTimeBetween, studyWeekStartKey } from "@/src/core";
import type { StudyTimeDay } from "@/src/core";

/**
 * /time — the Study time tracker (issue #16, owner-approved 2026-11-27).
 *
 * The owner's picture: "a bunch of squares with each square representing a
 * day". So the page is a contribution-style calendar: sixteen weeks of
 * local days, Monday-first rows, one square per day shaded by how long the
 * learner was in a session that day (five fixed steps: none, under 15m,
 * under 30m, under 1h, 1h+). Above it, the three numbers that answer the
 * real question — today, this week, all time.
 *
 * Server-rendered from one store read (chatStore.studyTimeByDay), so the
 * page can never disagree with the session pages: both fold the same
 * per-day logs. No client state — a pure function of the days handed in.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];
/** Five fixed intensity steps; level 0 is the empty square, not a shade of
 *  green (no time is not "a little time"). */
const LEVEL_CLASS = ["bg-muted", "bg-green-500/20", "bg-green-500/40", "bg-green-500/65", "bg-green-500"] as const;

function dayDate(key: string): Date {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function dayLabel(key: string): string {
	const date = dayDate(key);
	return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function StudyTimeView({ days, today }: { days: StudyTimeDay[]; today: Date }) {
	const todayKey = studyDayKey(today);
	const weekStart = studyWeekStartKey(today);
	const todayMs = studyTimeBetween(days, todayKey, todayKey);
	const weekMs = studyTimeBetween(days, weekStart, todayKey);
	let allMs = 0;
	for (const entry of days) allMs += entry.ms;

	const weeks = studyCalendar(days, today, 16);
	const hasAny = allMs > 0;

	return (
		<div className="space-y-6" data-testid="study-time-view">
			<div className="grid grid-cols-3 gap-3">
				<Stat label="Today" ms={todayMs} testId="study-total-today" />
				<Stat label="This week" ms={weekMs} testId="study-total-week" />
				<Stat label="All time" ms={allMs} testId="study-total-all" />
			</div>

			<section className="rounded-xl border bg-card p-4">
				<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
					<h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Last 16 weeks
					</h2>
					<span className="text-xs text-muted-foreground">
						{formatStudySpan(allMs)} counted
					</span>
				</div>
				<div className="overflow-x-auto pb-1">
					<div className="inline-flex gap-[3px] text-[10px] leading-none text-muted-foreground">
						<div className="flex flex-col gap-[3px] pr-1">
							<div className="h-4" aria-hidden="true" />
							{WEEKDAY_LABELS.map((label, index) => (
								<div key={index} className="flex h-3 w-5 items-center">
									{label}
								</div>
							))}
						</div>
						{weeks.map((week, index) => {
							const first = week[0];
							if (first === undefined) return null;
							const firstDate = dayDate(first.day);
							const previousFirst = index > 0 ? weeks[index - 1]?.[0] : undefined;
							const previous = previousFirst === undefined ? null : dayDate(previousFirst.day);
							const monthLabel =
								previous === null || previous.getMonth() !== firstDate.getMonth()
									? MONTHS[firstDate.getMonth()]
									: "";
							return (
								<div key={first.day} className="flex flex-col gap-[3px]">
									<div className="relative h-4 w-3">
										{monthLabel !== "" && (
											<span className="absolute left-0 top-0 whitespace-nowrap">{monthLabel}</span>
										)}
									</div>
									{week.map((day) => {
										if (day.day > todayKey) return <div key={day.day} className="size-3" aria-hidden="true" />;
										const level = studyLevel(day.ms);
										const label =
											day.day === todayKey
												? `Today, ${formatStudySpan(day.ms)}`
												: `${dayLabel(day.day)}: ${day.ms > 0 ? formatStudySpan(day.ms) : "no study time"}`;
										return (
											<div
												key={day.day}
												role="img"
												aria-label={label}
												title={label}
												data-testid="study-day"
												data-day={day.day}
												data-level={level}
												className={`size-3 rounded-[3px] ${LEVEL_CLASS[level]}`}
											/>
										);
									})}
								</div>
							);
						})}
					</div>
				</div>
				<div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
					<span>Less</span>
					{LEVEL_CLASS.map((className, level) => (
						<span key={level} className={`size-3 rounded-[3px] ${className}`} aria-hidden="true" />
					))}
					<span>More</span>
					<span className="ml-2">· under 15m, under 30m, under 1h, 1h or more</span>
				</div>
			</section>

			<p className="text-sm text-muted-foreground">
				{hasAny
					? "Time counts while a session is open and you are active in it; it pauses after two minutes without input and stops when you leave the page."
					: "No study time counted yet. Time starts when you send a prompt or upload a file in a session."}
			</p>
		</div>
	);
}

function Stat({ label, ms, testId }: { label: string; ms: number; testId: string }) {
	return (
		<div className="rounded-xl border bg-card p-4">
			<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
			<div data-testid={testId} className="mt-1 text-2xl font-semibold tabular-nums">
				{formatStudySpan(ms)}
			</div>
		</div>
	);
}