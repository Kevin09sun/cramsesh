import type { Metadata } from "next";
import { Nunito } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { THEME_BOOT_SCRIPT } from "@/components/settings/theme-boot";
import UpdateBanner from "@/components/update-banner";

// One family for chrome, teaching prose and titles: Nunito (code keeps a
// monospace stack — see the @theme font mapping in globals.css).
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito" });

export const metadata: Metadata = {
	title: "Cramsesh",
	description: "AP prep made EZ — a study buddy that teaches, quizzes, and checks your thinking.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		// The boot script may swap dark → light before hydration.
		<html lang="en" className={`dark ${nunito.variable}`} suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
			</head>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
