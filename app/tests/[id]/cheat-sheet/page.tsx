import { notFound } from "next/navigation";

import { CheatSheetPage } from "@/components/test-prep/cheat-sheet-view";
import { stores } from "@/src/server";

/**
 * /tests/[id]/cheat-sheet — one test's revision sheet (issue #15).
 *
 * Server-read like the readiness page; the client body owns the build
 * polling and the print action. An unknown id is a 404, not an empty page.
 */

export const dynamic = "force-dynamic";

export default async function TestCheatSheetPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const test = stores.testStore.get(id);
	if (!test) notFound();
	return <CheatSheetPage test={test} />;
}