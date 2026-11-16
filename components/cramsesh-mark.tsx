/**
 * CramseshMark — the late-night mug on bright blue, inlined as JSX so it
 * rides along with the components (no network fetch, crisp at any size).
 * The geometry is build/brand/cramsesh-mark.svg scaled to a 1024 viewBox;
 * sizing is the consumer's job. The mark is brand-fixed (it does not follow
 * the page theme), so the sidebar shows the same artwork in light and dark.
 */
export function CramseshMark({ className = "" }: { className?: string }) {
	return (
		<svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
			<rect width="1024" height="1024" rx="225.28" fill="#3D6FB6" />
			<path
				d="M389.12 368.64c-40.96-51.2 40.96-81.92 0-143.36M491.52 368.64c-40.96-51.2 40.96-81.92 0-143.36M593.92 368.64c-40.96-51.2 40.96-81.92 0-143.36"
				fill="none"
				stroke="#FBF6EA"
				strokeWidth="51.2"
				strokeLinecap="round"
			/>
			<rect x="286.72" y="430.08" width="389.12" height="368.64" rx="71.68" fill="#F2B33D" />
			<path d="M675.84 512h51.2a81.92 81.92 0 0 1 0 163.84h-51.2" fill="none" stroke="#F2B33D" strokeWidth="61.44" />
			<path
				d="M378.88 614.4l71.68 71.68l133.12-133.12"
				fill="none"
				stroke="#3D6FB6"
				strokeWidth="61.44"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
