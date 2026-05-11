import { createFileRoute } from "@tanstack/react-router"
import { ArchitectureSection } from "#/components/architecture-section"
import { CtaSection } from "#/components/cta-section"
import { HeroSection } from "#/components/hero-section"
import { PhilosophySection } from "#/components/philosophy-section"

export const Route = createFileRoute("/")({ component: Home })

function Home() {
	return (
		<main>
			<HeroSection />
			<PhilosophySection />
			<ArchitectureSection />
			<CtaSection />
		</main>
	)
}
