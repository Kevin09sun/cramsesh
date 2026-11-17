"use client";

import type React from "react";
import Link from "next/link";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { SessionRow } from "@/components/sidebar";
import { cn } from "@/lib/utils";
import type { ChatListItem, FolderSection, SessionFolder, SessionTree } from "@/src/core";

/**
 * Sidebar session folders (2026-11-17): the Tests and AP sections above the
 * flat session list. Pure render of the grouped sessions and the EFFECTIVE
 * open set (openFolderKeys) — the same set the keyboard walk reads, so what
 * shows is what ↑/↓ visit. A section is open unless its collapsed:* key is
 * in the set; a folder is open when its key is. The headings are the doors
 * to /tests and /ap (the old sidebar links' successors).
 */

const SECTIONS: readonly { section: FolderSection; label: string; href: string }[] = [
	{ section: "tests", label: "Tests", href: "/tests" },
	{ section: "ap", label: "AP", href: "/ap" },
];

const HEADING_CLASS =
	"text-xs uppercase tracking-widest text-muted-foreground/70 transition-colors hover:text-foreground";
const ICON_BUTTON_CLASS =
	"flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export function SessionFolderTree({
	tree,
	open,
	onToggle,
	activeId,
	kbdId,
	onNewTestSession,
	renderRow,
}: {
	tree: SessionTree;
	open: ReadonlySet<string>;
	onToggle(key: string): void;
	activeId: string | null;
	kbdId: string | null;
	onNewTestSession(testId: string): void;
	/** The sidebar supplies its own row (navigation, context menu, inline
	 *  rename); the default is a plain SessionRow for the render seam. */
	renderRow?: (chat: ChatListItem) => React.ReactNode;
}) {
	const row =
		renderRow ??
		((chat: ChatListItem) => (
			<SessionRow
				key={chat.id}
				chat={chat}
				active={chat.id === activeId}
				kbdSelected={chat.id === kbdId}
				onOpen={() => {}}
			/>
		));
	return (
		<div data-testid="session-folder-tree" className="mb-1">
			{SECTIONS.map(({ section, label, href }) => {
				const collapseKey = `collapsed:${section}`;
				const sectionOpen = !open.has(collapseKey);
				return (
					<div key={section} className="mb-1">
						<div className="flex items-center gap-1 px-1 py-0.5">
							<button
								type="button"
								data-testid={`folder-collapse-${section}`}
								aria-expanded={sectionOpen}
								aria-label={`${sectionOpen ? "Collapse" : "Expand"} ${label}`}
								onClick={() => onToggle(collapseKey)}
								className={ICON_BUTTON_CLASS}
							>
								<ChevronRightIcon className={cn("size-3 transition-transform", sectionOpen && "rotate-90")} />
							</button>
							<Link href={href} data-testid={`folder-section-${section}`} className={HEADING_CLASS}>
								{label}
							</Link>
						</div>
						{sectionOpen &&
							tree[section].map((folder) => (
								<FolderBlock
									key={folder.key}
									folder={folder}
									isOpen={open.has(folder.key)}
									onToggle={onToggle}
									onNewTestSession={onNewTestSession}
									row={row}
								/>
							))}
					</div>
				);
			})}
		</div>
	);
}

function FolderBlock({
	folder,
	isOpen,
	onToggle,
	onNewTestSession,
	row,
}: {
	folder: SessionFolder;
	isOpen: boolean;
	onToggle(key: string): void;
	onNewTestSession(testId: string): void;
	row: (chat: ChatListItem) => React.ReactNode;
}) {
	const id = folder.id;
	const plusTestid = `folder-new-${folder.key}`;
	return (
		<div>
			<div className="flex items-center gap-0.5">
				<button
					type="button"
					data-testid={`folder-${folder.key}`}
					aria-expanded={isOpen}
					onClick={() => onToggle(folder.key)}
					className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
				>
					<ChevronRightIcon
						className={cn("size-3 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
					/>
					<span className="min-w-0 flex-1 truncate font-prose text-(length:--lh-prose-size)">{folder.name}</span>
					<span className="shrink-0 text-xs text-muted-foreground">{folder.sessions.length}</span>
				</button>
				{id !== null &&
					(folder.section === "tests" ? (
						<button
							type="button"
							data-testid={plusTestid}
							aria-label={`New session for ${folder.name}`}
							onClick={() => onNewTestSession(id)}
							className={ICON_BUTTON_CLASS}
						>
							<PlusIcon className="size-3" />
						</button>
					) : (
						<Link
							href={`/ap/${id}`}
							data-testid={plusTestid}
							aria-label={`Open ${folder.name}`}
							className={ICON_BUTTON_CLASS}
						>
							<PlusIcon className="size-3" />
						</Link>
					))}
			</div>
			{isOpen && <div className="pl-3">{folder.sessions.map((chat) => row(chat))}</div>}
		</div>
	);
}
