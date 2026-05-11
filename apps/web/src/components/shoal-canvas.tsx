import { type CSSProperties, useEffect, useRef, useState } from "react"
import * as THREE from "three"

// Geometry-Wars-inspired neon palette: saturated, additively-blended colours
// that pop against the near-black hero background. Additive blending alone
// gives the lines their glow — no bloom pass needed.
const NEON_COLORS = [
	0x4ff8ff, // cyan
	0xff4fff, // magenta
	0xffd84a, // amber-yellow
	0x49ff9a, // emerald
	0xff7a32, // orange
	0xff5fa8, // hot pink
	0x9b6cff, // violet
	0x9bff42, // lime
]

interface FleetNode {
	name: string
	serving: ReadonlyArray<string>
}

const FLEET: ReadonlyArray<FleetNode> = [
	{ name: "Tim's Homelab Cluster", serving: ["smollm3-3b", "phi-4-mini-3.8b", "granite-3.3-8b"] },
	{ name: "Tim's Framework 13 Pro", serving: ["smollm3-3b", "phi-4-mini-3.8b", "granite-3.3-8b"] },
	{ name: "Jye's Mac Studio", serving: ["llama-4-scout-109b-a17b", "qwen3-235b-a22b"] },
	{ name: "Jye's MacBook Pro", serving: ["llama-3.3-70b"] },
	{ name: "Dave's Dell XPS 14", serving: ["qwen3-32b", "qwen3-vl-32b"] },
	{ name: "Ryan's Macbook Pro", serving: ["mistral-large-2411-123b", "llama-3.3-70b"] },
	{ name: "Tim's Framework Desktop", serving: ["deepseek-v3-671b-a37b", "llama-3.3-70b"] },
]

// Fish are uniform geometry; variation comes from colour, scale, and motion.
// Body length is 1 unit (nose at +X, tail base at -X). The mesh is built with
// local +X = forward so velocity-based heading alignment is direct.
const FISH_LENGTH_FORWARD = 0.55
const FISH_LENGTH_TAIL = -0.5
const FISH_BASE_SCALE_MIN = 0.55
const FISH_BASE_SCALE_MAX = 0.95
const FISH_SPEED_MIN = 0.04
const FISH_SPEED_MAX = 0.085
const FISH_TAIL_FREQ = 9
const FISH_TAIL_AMP = 0.5
const FISH_HIT_RADIUS_MUL = 1.7
const FISH_TURN_RATE = 6 // slerp factor per second

interface Fish {
	group: THREE.Group // position + heading (quaternion)
	pivot: THREE.Group // body wiggle yaw
	body: THREE.LineSegments
	tail: THREE.LineLoop
	bodyMat: THREE.LineBasicMaterial
	tailMat: THREE.LineBasicMaterial
	velocity: THREE.Vector3
	baseScale: number
	phase: number
	spinAxis: THREE.Vector3
	color: THREE.Color
	name: string
	serving: ReadonlyArray<string>
}

interface CaughtInfo {
	name: string
	serving: ReadonlyArray<string>
	initialX: number
	initialY: number
}

interface ShoalCanvasProps {
	className?: string
}

const CANVAS_BASE_STYLE: CSSProperties = {
	position: "absolute",
	inset: 0,
	width: "100%",
	height: "100%",
	display: "block",
}

export function ShoalCanvas({ className }: ShoalCanvasProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const popoverRef = useRef<HTMLDivElement>(null)
	const caughtIndexRef = useRef<number | null>(null)
	const [caught, setCaught] = useState<CaughtInfo | null>(null)

	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return
		const container = canvas.parentElement
		if (!container) return

		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches

		const scene = new THREE.Scene()
		const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)
		camera.position.set(0, 0, 26)

		const renderer = new THREE.WebGLRenderer({
			canvas,
			alpha: true,
			antialias: false,
			powerPreference: "low-power",
		})
		// Render at 1× regardless of devicePixelRatio. With additive lines on a
		// dark backdrop, the perceived crispness loss is minimal but fragment
		// work drops 2-4× on retina/4K.
		renderer.setPixelRatio(1)
		renderer.setClearColor(0x000000, 0)

		const bodyGeom = createFishBodyWireframe()
		const tailGeom = createFishTailOutline()
		const SHELL_RADIUS = 14

		const fishCount = reduceMotion ? 10 : 20
		const fishes: Fish[] = []

		for (let i = 0; i < fishCount; i++) {
			fishes.push(
				makeFish({
					bodyGeom,
					tailGeom,
					colorHex: NEON_COLORS[i % NEON_COLORS.length],
					identity: FLEET[i % FLEET.length],
					shellRadius: SHELL_RADIUS,
				}),
			)
		}

		for (const f of fishes) scene.add(f.group)

		function resize() {
			const cw = (container as HTMLElement).clientWidth
			const ch = (container as HTMLElement).clientHeight
			if (!cw || !ch) return
			renderer.setSize(cw, ch, false)
			camera.aspect = cw / ch
			camera.updateProjectionMatrix()
		}
		resize()

		const ro = new ResizeObserver(resize)
		ro.observe(container)

		const SEPARATION_RADIUS = 2.6
		const SEPARATION = 0.022
		const SHELL_PULL = 0.0035
		const ORBITAL_BIAS = 0.0014

		const sep = new THREE.Vector3()
		const radial = new THREE.Vector3()
		const orbital = new THREE.Vector3()
		const projected = new THREE.Vector3()

		// Heading alignment scratch
		const forwardDir = new THREE.Vector3()
		const upWorld = new THREE.Vector3(0, 1, 0)
		const altUp = new THREE.Vector3(0, 0, 1)
		const tmpRight = new THREE.Vector3()
		const tmpUp = new THREE.Vector3()
		const orientMat = new THREE.Matrix4()
		const targetQuat = new THREE.Quaternion()

		function alignToVelocity(
			group: THREE.Group,
			velocity: THREE.Vector3,
			dt: number,
		) {
			if (velocity.lengthSq() < 1e-6) return
			forwardDir.copy(velocity).normalize()
			// Pick a stable up reference; if forward is nearly vertical, fall back
			// to world Z so the cross product stays well-defined.
			const refUp = Math.abs(forwardDir.y) > 0.95 ? altUp : upWorld
			tmpRight.crossVectors(forwardDir, refUp).normalize()
			tmpUp.crossVectors(tmpRight, forwardDir).normalize()
			orientMat.makeBasis(forwardDir, tmpUp, tmpRight)
			targetQuat.setFromRotationMatrix(orientMat)
			group.quaternion.slerp(targetQuat, Math.min(1, dt * FISH_TURN_RATE))
		}

		const raycaster = new THREE.Raycaster()
		const ndcPointer = new THREE.Vector2()

		function findFishAt(clientX: number, clientY: number): number | null {
			const rect = (container as HTMLElement).getBoundingClientRect()
			if (
				clientX < rect.left ||
				clientX > rect.right ||
				clientY < rect.top ||
				clientY > rect.bottom
			) {
				return null
			}
			ndcPointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
			ndcPointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1)
			raycaster.setFromCamera(ndcPointer, camera)

			let bestIdx = -1
			let bestDist = Infinity
			for (let i = 0; i < fishes.length; i++) {
				const f = fishes[i]
				if (f.group.position.z < 0) continue
				const d = raycaster.ray.distanceToPoint(f.group.position)
				const hitR = f.baseScale * FISH_HIT_RADIUS_MUL
				if (d < hitR) {
					const camDist = camera.position.distanceTo(f.group.position)
					if (camDist < bestDist) {
						bestDist = camDist
						bestIdx = i
					}
				}
			}
			return bestIdx >= 0 ? bestIdx : null
		}

		function projectToScreen(pos: THREE.Vector3): { x: number; y: number } {
			projected.copy(pos).project(camera)
			const cw = (container as HTMLElement).clientWidth
			const ch = (container as HTMLElement).clientHeight
			return {
				x: (projected.x + 1) * 0.5 * cw,
				y: (1 - projected.y) * 0.5 * ch,
			}
		}

		function onPointerMove(ev: PointerEvent) {
			const idx = findFishAt(ev.clientX, ev.clientY)
			;(container as HTMLElement).style.cursor =
				idx !== null ? "pointer" : ""
		}

		function onPointerDown(ev: PointerEvent) {
			const target = ev.target as HTMLElement | null
			if (target?.closest("a, button, input, textarea, select")) return

			const idx = findFishAt(ev.clientX, ev.clientY)
			if (idx === null) {
				if (caughtIndexRef.current !== null) {
					caughtIndexRef.current = null
					setCaught(null)
				}
				return
			}
			if (idx === caughtIndexRef.current) {
				caughtIndexRef.current = null
				setCaught(null)
				return
			}
			caughtIndexRef.current = idx
			const f = fishes[idx]
			const screen = projectToScreen(f.group.position)
			setCaught({
				name: f.name,
				serving: f.serving,
				initialX: screen.x,
				initialY: screen.y,
			})
		}

		window.addEventListener("pointermove", onPointerMove)
		window.addEventListener("pointerdown", onPointerDown)

		let raf = 0
		let prev = performance.now()
		let visible = true

		const io = new IntersectionObserver(
			(entries) => {
				visible = entries[0]?.isIntersecting ?? true
				if (visible) prev = performance.now()
			},
			{ threshold: 0.01 },
		)
		io.observe(container)

		function step(now: number) {
			raf = requestAnimationFrame(step)
			if (!visible) {
				prev = now
				return
			}
			const dt = Math.min((now - prev) / 1000, 0.05)
			prev = now
			const t = now * 0.001
			const caughtIdx = caughtIndexRef.current

			for (let i = 0; i < fishes.length; i++) {
				const f = fishes[i]

				if (i === caughtIdx) {
					f.tail.rotation.y =
						Math.sin(t * FISH_TAIL_FREQ + f.phase) * FISH_TAIL_AMP
					f.pivot.rotation.y = Math.sin(t * 1.4 + f.phase) * 0.25
					continue
				}

				sep.set(0, 0, 0)
				for (let j = 0; j < fishes.length; j++) {
					if (i === j) continue
					const other = fishes[j]
					const dx = f.group.position.x - other.group.position.x
					const dy = f.group.position.y - other.group.position.y
					const dz = f.group.position.z - other.group.position.z
					const d2 = dx * dx + dy * dy + dz * dz
					if (
						d2 < SEPARATION_RADIUS * SEPARATION_RADIUS &&
						d2 > 0.0001
					) {
						const d = Math.sqrt(d2)
						const w = 1 - d / SEPARATION_RADIUS
						sep.x += (dx / d) * w
						sep.y += (dy / d) * w
						sep.z += (dz / d) * w
					}
				}
				sep.multiplyScalar(SEPARATION)
				f.velocity.add(sep)

				radial.copy(f.group.position)
				const r = radial.length()
				if (r > 0.001) {
					const diff = r - SHELL_RADIUS
					radial.multiplyScalar((-diff * SHELL_PULL) / r)
					f.velocity.add(radial)
				}

				orbital
					.crossVectors(f.spinAxis, f.group.position)
					.multiplyScalar(ORBITAL_BIAS)
				f.velocity.add(orbital)

				const speed = f.velocity.length()
				if (speed > FISH_SPEED_MAX) f.velocity.setLength(FISH_SPEED_MAX)
				else if (speed < FISH_SPEED_MIN) f.velocity.setLength(FISH_SPEED_MIN)

				f.group.position.addScaledVector(f.velocity, dt * 60)

				alignToVelocity(f.group, f.velocity, dt)
				f.pivot.rotation.y = Math.sin(t * 2.6 + f.phase) * 0.12
				f.tail.rotation.y =
					Math.sin(t * FISH_TAIL_FREQ + f.phase) * FISH_TAIL_AMP
			}

			if (caughtIdx !== null && popoverRef.current) {
				const fish = fishes[caughtIdx]
				const screen = projectToScreen(fish.group.position)
				popoverRef.current.style.transform = `translate(${screen.x}px, ${screen.y}px)`
			}

			renderer.render(scene, camera)
		}

		raf = requestAnimationFrame(step)

		return () => {
			cancelAnimationFrame(raf)
			ro.disconnect()
			io.disconnect()
			window.removeEventListener("pointermove", onPointerMove)
			window.removeEventListener("pointerdown", onPointerDown)
			;(container as HTMLElement).style.cursor = ""
			caughtIndexRef.current = null

			for (const f of fishes) {
				scene.remove(f.group)
				f.bodyMat.dispose()
				f.tailMat.dispose()
			}
			bodyGeom.dispose()
			tailGeom.dispose()
			renderer.dispose()
		}
	}, [])

	return (
		<>
			<canvas
				ref={canvasRef}
				aria-hidden="true"
				tabIndex={-1}
				className={className}
				style={{ ...CANVAS_BASE_STYLE, zIndex: 0 }}
			/>
			{caught ? (
				<div
					ref={popoverRef}
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						zIndex: 30,
						pointerEvents: "none",
						transform: `translate(${caught.initialX}px, ${caught.initialY}px)`,
						willChange: "transform",
					}}
				>
					<FishPopover name={caught.name} serving={caught.serving} />
				</div>
			) : null}
			<div className="sr-only" aria-live="polite" aria-atomic="true">
				{caught
					? `Caught node ${caught.name} serving ${caught.serving.join(", ")}. Click again or click elsewhere to release.`
					: ""}
			</div>
		</>
	)
}

// ----------------------------------------------------------------------
// Fish factory

interface MakeFishOpts {
	bodyGeom: THREE.BufferGeometry
	tailGeom: THREE.BufferGeometry
	colorHex: number
	identity: FleetNode
	shellRadius: number
}

function makeFish(opts: MakeFishOpts): Fish {
	const color = new THREE.Color(opts.colorHex)

	const bodyMat = neonLineMaterial(color)
	const tailMat = neonLineMaterial(color)
	const body = new THREE.LineSegments(opts.bodyGeom, bodyMat)
	const tail = new THREE.LineLoop(opts.tailGeom, tailMat)

	const baseScale =
		FISH_BASE_SCALE_MIN +
		Math.random() * (FISH_BASE_SCALE_MAX - FISH_BASE_SCALE_MIN)

	// pivot carries a small yaw wiggle so it doesn't fight the heading
	// quaternion on `group`.
	const pivot = new THREE.Group()
	pivot.scale.setScalar(baseScale)
	pivot.add(body)
	pivot.add(tail)
	tail.position.x = FISH_LENGTH_TAIL

	const group = new THREE.Group()
	group.add(pivot)
	group.position.copy(randomShellPosition(opts.shellRadius))

	const spinAxis = randomSpinAxis()
	const speed =
		FISH_SPEED_MIN + Math.random() * (FISH_SPEED_MAX - FISH_SPEED_MIN)
	const tangent = new THREE.Vector3().crossVectors(spinAxis, group.position)
	if (tangent.lengthSq() < 0.0001) tangent.set(1, 0, 0)
	tangent.normalize().multiplyScalar(speed)

	return {
		group,
		pivot,
		body,
		tail,
		bodyMat,
		tailMat,
		velocity: tangent,
		baseScale,
		phase: Math.random() * Math.PI * 2,
		spinAxis,
		color,
		name: opts.identity.name,
		serving: opts.identity.serving,
	}
}

function neonLineMaterial(color: THREE.Color): THREE.LineBasicMaterial {
	return new THREE.LineBasicMaterial({
		color,
		transparent: true,
		opacity: 1,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
	})
}

// ----------------------------------------------------------------------
// Fish geometry — single procedural low-poly mesh, lofted from elliptical
// cross-sections along the body axis. We emit raw line segments (longitudinal
// ribs + circumferential rings) directly so the wireframe stays clean — using
// EdgesGeometry on a curved surface would either drop too much or include
// quad-diagonal noise.

function createFishBodyWireframe(): THREE.BufferGeometry {
	// [x, yRadius, zRadius] — fish is taller than wide, peak girth past head.
	const sections: ReadonlyArray<readonly [number, number, number]> = [
		[FISH_LENGTH_FORWARD, 0.0, 0.0], // nose
		[0.32, 0.13, 0.08],
		[0.05, 0.18, 0.13], // peak girth
		[-0.2, 0.14, 0.09],
		[-0.4, 0.06, 0.04],
		[FISH_LENGTH_TAIL, 0.0, 0.0], // tail base
	]
	const radial = 6
	const positions: number[] = []

	function ringPoint(s: number, r: number): readonly [number, number, number] {
		const [x, yR, zR] = sections[s]
		const a = (r / radial) * Math.PI * 2
		return [x, Math.cos(a) * yR, Math.sin(a) * zR]
	}

	// Longitudinal ribs (head→tail along each radial slot)
	for (let s = 0; s < sections.length - 1; s++) {
		for (let r = 0; r < radial; r++) {
			const [x1, y1, z1] = ringPoint(s, r)
			const [x2, y2, z2] = ringPoint(s + 1, r)
			positions.push(x1, y1, z1, x2, y2, z2)
		}
	}

	// Circumferential rings (skip degenerate tip rings)
	for (let s = 0; s < sections.length; s++) {
		const [, yR, zR] = sections[s]
		if (yR === 0 && zR === 0) continue
		for (let r = 0; r < radial; r++) {
			const [x1, y1, z1] = ringPoint(s, r)
			const [x2, y2, z2] = ringPoint(s, (r + 1) % radial)
			positions.push(x1, y1, z1, x2, y2, z2)
		}
	}

	const geom = new THREE.BufferGeometry()
	geom.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3),
	)
	return geom
}

function createFishTailOutline(): THREE.BufferGeometry {
	// Vertical tail fin in the local XY plane; hinge at local origin so
	// rotation.y sweeps the fin sideways through Z (the swim wag axis).
	const pts: ReadonlyArray<readonly [number, number]> = [
		[0, 0.12],
		[-0.32, 0.36],
		[-0.18, 0.0],
		[-0.32, -0.36],
		[0, -0.12],
	]
	const positions = new Float32Array(pts.length * 3)
	for (let i = 0; i < pts.length; i++) {
		positions[i * 3] = pts[i][0]
		positions[i * 3 + 1] = pts[i][1]
		positions[i * 3 + 2] = 0
	}
	const geom = new THREE.BufferGeometry()
	geom.setAttribute("position", new THREE.BufferAttribute(positions, 3))
	return geom
}

// ----------------------------------------------------------------------
// Helpers

function randomShellPosition(shellRadius: number): THREE.Vector3 {
	const u = Math.random()
	const v = Math.random()
	const phi = Math.acos(2 * u - 1)
	const theta = 2 * Math.PI * v
	const r = shellRadius * (0.85 + Math.random() * 0.3)
	return new THREE.Vector3(
		r * Math.sin(phi) * Math.cos(theta),
		r * Math.sin(phi) * Math.sin(theta) * 0.85,
		r * Math.cos(phi),
	)
}

function randomSpinAxis(): THREE.Vector3 {
	return new THREE.Vector3(
		Math.random() * 2 - 1,
		Math.random() * 2 - 1,
		Math.random() * 2 - 1,
	).normalize()
}

// ----------------------------------------------------------------------
// Popover

function FishPopover({
	name,
	serving,
}: {
	name: string
	serving: ReadonlyArray<string>
}) {
	return (
		<div
			className="island-shell rounded-sm px-4 py-3 select-none"
			style={{ transform: "translate(-50%, calc(-100% - 14px))" }}
		>
			<div className="flex items-center gap-2">
				<span className="block h-2 w-2 rounded-full bg-[var(--lagoon-deep)]" />
				<span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--lagoon-deep)]">
					Online
				</span>
			</div>
			<div className="mt-1.5 text-sm font-semibold text-[var(--sea-ink)] whitespace-nowrap">
				{name}
			</div>
			<div className="mt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
				Serving
			</div>
			<ul className="mt-1 space-y-0.5">
				{serving.map((model) => (
					<li
						key={model}
						className="text-xs text-[var(--sea-ink-soft)] whitespace-nowrap"
					>
						{model}
					</li>
				))}
			</ul>
		</div>
	)
}
