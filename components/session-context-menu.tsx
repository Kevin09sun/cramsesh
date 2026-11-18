"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { MenuShell } from "@/components/menu-shell";
import type { ChatDeleteMode, ChatListItem } from "@/src/core";

/**
 * The per-session right-click menu, shared by the sidebar's session rows and
 * the Sessions block on a test or course page (study boxes, 2026-11-17 —
 * owner: the same menu in both places, so Tests/AP sessions can be renamed,
 * deleted and exported from their box).
 *
 * Wave 6 chunk A: Rename / Export / Delete first (owner ruling), then —
 * below a hairline — the extraction coverage block (owner-locked redesign
 * 2026-09-24). The anchor is the row that was right-clicked — assigned into
 * a ref before the state flip so the shell measures it on its first
 * (hidden) pass. Keyboard: the native contextmenu event (the Menu key /
 * Shift+F10 on a focused row) opens it; MenuShell owns focus and the arrow
 * machine; Esc closes.
 *
 * The hook owns no list and no router: each host patches or refetches its
 * own list through onRenamed / onDeleted (the sidebar patches its snapshot
 * and leaves a deleted open session; a box page refreshes its server
 * render).
 */

/** What the menu needs of a session: its id and its title. */
export type MenuSession = Pick<ChatListItem, "id" | "title">;

/** The menu's item test ids, top to bottom (the coverage block follows). */
export const SESSION_MENU_ITEM_IDS = ["ctx-rename", "ctx-export-md", "ctx-delete"] as const;

/** The session's Markdown export URL (the session-markdown route). */
export function sessionMarkdownHref(chatId: string): string {
	return `/api/chats/${chatId}/markdown`;
}

/** Export as Markdown (owner, release polish 2026-10-06): a same-origin
 *  anchor download; the route's Content-Disposition names the file. */
export function downloadSessionMarkdown(chatId: string): void {
	const a = document.createElement("a");
	a.href = sessionMarkdownHref(chatId);
	a.download = ""; // the route's filename wins
	document.body.appendChild(a);
	a.click();
	a.remove();
}

/** PUT a session's title. Empty (after trim) = discard → null; otherwise the
 *  committed title. Throws on a failed write. Announces lh:chat-renamed so
 *  every listener (the sidebar snapshot, an open chat header) patches. */
export async function renameSession(id: string, next: string, fetchLike: typeof fetch = fetch): Promise<string | null> {
	const t = next.trim();
	if (t === "") return null;
	const res = await fetchLike(`/api/chats/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title: t }),
	});
	if (!res.ok) throw new Error(`rename failed: ${res.status}`);
	window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title: t } }));
	return t;
}

/** The menu's items — pure (the render seam). Rename / Export / Delete (the
 *  destructive action stays last — the danger-fence law). */
export function SessionMenuItems({
	onRename,
	onExport,
	onDelete,
}: {
	onRename: () => void;
	onExport: () => void;
	onDelete: () => void;
}) {
	return (
		<>
			<button
				type="button"
				data-testid="ctx-rename"
				onClick={onRename}
				className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
			>
				Rename
			</button>
			<button
				type="button"
				data-testid="ctx-export-md"
				onClick={onExport}
				className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
			>
				Export as Markdown…
			</button>
			<button
				type="button"
				data-testid="ctx-delete"
				onClick={onDelete}
				className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
			>
				Delete…
			</button>
		</>
	);
}

/** The inline-rename text input (wave 6): select-all on entry (the click
 *  means "replace", the header rename's rule), Enter/blur commits, Esc
 *  discards. The host supplies the row around it and the input's classes. */
export function SessionRenameInput({
	title,
	onCommit,
	onCancel,
	className,
}: {
	title: string;
	onCommit: (next: string) => void;
	onCancel: () => void;
	className: string;
}) {
	const [draft, setDraft] = useState(title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<input
			ref={inputRef}
			value={draft}
			spellCheck={false}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => onCommit(draft)}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					e.stopPropagation(); // discard, not also the sidebar/chat chains
					onCancel();
				}
			}}
			aria-label="Rename session"
			data-testid="session-rename-input"
			className={className}
		/>
	);
}

export interface SessionContextMenu {
	/** The row's onContextMenu: suppresses the native menu, anchors on the row. */
	openContext: (e: React.MouseEvent<HTMLElement>, session: MenuSession) => void;
	/** The session being renamed in place, if any. */
	renamingId: string | null;
	commitRename: (id: string, next: string) => Promise<void>;
	cancelRename: () => void;
	/** The menu (when open) and the delete dialog — render once, anywhere. */
	menu: React.ReactNode;
}

export function useSessionContextMenu({
	onRenamed,
	onDeleted,
}: {
	/** After a successful rename (lh:chat-renamed already fired). */
	onRenamed?: (id: string, title: string) => void;
	/** After a successful delete (lh:graph-revision already fired). */
	onDeleted?: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
} = {}): SessionContextMenu {
	const [ctx, setCtx] = useState<MenuSession | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<MenuSession | null>(null);

	const onRenamedRef = useRef(onRenamed);
	onRenamedRef.current = onRenamed;
	const onDeletedRef = useRef(onDeleted);
	onDeletedRef.current = onDeleted;

	const openContext = useCallback((e: React.MouseEvent<HTMLElement>, session: MenuSession) => {
		e.preventDefault(); // suppress the native menu
		ctxAnchorRef.current = e.currentTarget;
		setCtx({ id: session.id, title: session.title });
	}, []);

	// The menu contract (agent-section's): any pointerdown outside the menu
	// or its row closes it; Esc is CLAIMED so it never also aborts a turn
	// or folds the sidebar. Right-clicking another row re-anchors: its
	// pointerdown closes this menu, its contextmenu opens the next.
	const ctxId = ctx?.id ?? null;
	useEffect(() => {
		if (ctxId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtx(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtx(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxId]);

	// Inline rename (owner ruling, wave 6): commit rides the SAME plumbing as
	// the header rename — PUT the title, then lh:chat-renamed patches every
	// listener. Esc discards; empty commit discards (the header's rules).
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		try {
			const t = await renameSession(id, next);
			if (t !== null) onRenamedRef.current?.(id, t);
		} catch (err) {
			console.error("rename failed:", err); // keep the old title
		}
	}, []);
	const cancelRename = useCallback(() => setRenamingId(null), []);

	// Delete success: announce the graph revision so the graph view
	// refetches (deletion is the one writer the status poll can't see — no
	// run ever transitions some→none), then the host patches its list.
	const handleDeleted = useCallback((id: string, mode: ChatDeleteMode, graphRevision: number) => {
		setDeleting(null);
		window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
		onDeletedRef.current?.(id, mode, graphRevision);
	}, []);
	const closeDelete = useCallback(() => setDeleting(null), []);

	const menu = (
		<>
			{/* The context menu (wave 6 + the extraction-UX redesign): the
			    management actions, then the coverage block below a hairline.
			    MenuShell owns placement/focus/arrow cycling; the dismissal
			    effect above owns the contract. */}
			{ctx !== null && (
				<MenuShell
					anchorRef={ctxAnchorRef}
					testid="session-context-menu"
					preferredSide="down"
					menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<SessionMenuItems
						onRename={() => {
							setRenamingId(ctx.id);
							setCtx(null);
						}}
						onExport={() => {
							const chatId = ctx.id;
							setCtx(null);
							downloadSessionMarkdown(chatId);
						}}
						onDelete={() => {
							setDeleting(ctx);
							setCtx(null);
						}}
					/>
					<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
					<CoverageMenuBlock chatId={ctx.id} />
				</MenuShell>
			)}
			{/* The two-option delete dialog (wave 6) — portaled to body by the
			    component itself. */}
			<DeleteSessionDialog chat={deleting} onClose={closeDelete} onDeleted={handleDeleted} />
		</>
	);

	return { openContext, renamingId, commitRename, cancelRename, menu };
}
