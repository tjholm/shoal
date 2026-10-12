import { createFileRoute } from "@tanstack/react-router"
import { DashboardSection } from "#/components/dashboard-section"
import { GetStarted } from "#/components/get-started"
import { HeroSection } from "#/components/hero-section"
import { DropIn, HowItWorks } from "#/components/how-it-works"
import { SiteFooter, SiteHeader } from "#/components/site-header"

export const Route = createFileRoute("/")({ component: Home })

function Home() {
	return (
		<>
			<SiteHeader />
			<main>
				<HeroSection />
				<DropIn />
				<HowItWorks />
				<DashboardSection />
				<GetStarted />
			</main>
			<SiteFooter />
		</>
	)
}
