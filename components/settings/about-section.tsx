/**
 * About (Task 5): the product mark, name and version, the tagline, and the
 * upstream credit, licence and source links. Read-only — no settings writes.
 * The credit wording is plan-mandated verbatim; the brand-copy guard allows
 * its single link text as-is.
 */
import { CramseshMark } from "@/components/cramsesh-mark";
import { APP_VERSION, HOMEPAGE } from "./update-settings.tsx";

const CREDIT_URL = "https://github.com/amosblomqvist/learnharness";
const LINK = "underline-offset-2 hover:text-foreground hover:underline";

export function AboutSection({
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	version?: string;
	homepage?: string;
}) {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-3">
				<CramseshMark className="size-12" />
				<div className="min-w-0">
					<p className="font-title text-2xl tracking-tight">Cramsesh</p>
					<p className="text-xs text-muted-foreground">{`Version ${version}`}</p>
				</div>
			</div>
			<p className="font-prose text-(length:--lh-prose-size) text-muted-foreground">
				AP prep made EZ
			</p>
			<div className="flex flex-col gap-1 text-sm text-muted-foreground">
				<p>
					<a href={CREDIT_URL} target="_blank" rel="noreferrer" className={LINK} data-testid="about-credit">
						Built on LearnHarness by Amos Blomqvist
					</a>
				</p>
				<p>
					<a href={`${homepage}/blob/custom/LICENSE`} target="_blank" rel="noreferrer" className={LINK} data-testid="about-license">
						Licensed under AGPL-3.0
					</a>
				</p>
				<p>
					<a href={homepage} target="_blank" rel="noreferrer" className={LINK} data-testid="about-source">
						Source code
					</a>
				</p>
			</div>
		</div>
	);
}