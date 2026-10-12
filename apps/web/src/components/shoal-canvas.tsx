import { useEffect, useRef } from "react"

const FISH_COUNT = 28

type Vec3 = [number, number, number]

interface Fish {
	p: Vec3
	v: Vec3
	/** Body scale, so the school isn't all one size. */
	size: number
	/** The speed this fish settles at, and a decaying burst above it. */
	cruise: number
	burst: number
	/** How far from the hub it likes to swim. */
	depth: number
	/** The axis it circles the hub around, tilted a little off vertical. */
	axis: Vec3
	swirl: number
	phase: number
	wander: number
}

/** Camera distance, in units of the school's radius. */
const CAMERA_DISTANCE = 3.2
const CAMERA_TILT = 0.38
const HUB_RADIUS = 0.085
/** World units per unit of fish geometry. */
const FISH_SCALE = 0.13
/** How much bigger the canvas is than the box it sits in. */
const BLEED = 1.5
/** The school's height over its width; the box matches it. */
const SCHOOL_HEIGHT = 1.25
const MIN_SPEED = 0.0014
const MAX_SPEED = 0.0065
/** Simulation seconds per step, for the tail and body wiggle. */
const STEP_SECONDS = 1 / 60
const TAIL_FREQ = 6
const TAIL_AMP = 0.5

/** A school of wireframe fish circling a lit hub: the workers around shoal. */
export function ShoalCanvas() {
	const canvasRef = useRef<HTMLCanvasElement>(null)

	useEffect(() => {
		const canvas = canvasRef.current
		const ctx = canvas?.getContext("2d")
		if (!canvas || !ctx) return

		const fish = spawnSchool()
		let angle = 0.6
		let time = 0

		const step = () => {
			stepSchool(fish, time)
			angle += 0.0005
			time += STEP_SECONDS
		}

		const draw = () => {
			const dpr = window.devicePixelRatio || 1
			const w = canvas.clientWidth
			const h = canvas.clientHeight
			if (!w || !h) return
			if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
				canvas.width = Math.round(w * dpr)
				canvas.height = Math.round(h * dpr)
			}
			const style = getComputedStyle(canvas)
			const lumen = style.getPropertyValue("--signal-lumen").trim()
			const mist = style.getPropertyValue("--text-secondary").trim()

			ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
			ctx.clearRect(0, 0, w, h)

			const ca = Math.cos(angle)
			const sa = Math.sin(angle)
			const ct = Math.cos(CAMERA_TILT)
			const st = Math.sin(CAMERA_TILT)
			const D = CAMERA_DISTANCE
			// The canvas overhangs its box by BLEED, so the school is sized to the
			// box and fish swimming wide fade out instead of hitting an edge.
			const view = Math.min(w, h / SCHOOL_HEIGHT) / BLEED
			const S = view * 0.5 * D
			const project = (x: number, y: number, z: number) => {
				const x1 = x * ca - z * sa
				const z1 = x * sa + z * ca
				const y2 = y * ct - z1 * st
				const depth = y * st + z1 * ct + D
				const k = S / depth
				return { x: w / 2 + x1 * k, y: h / 2 - y2 * k, depth, k }
			}
			type Point = ReturnType<typeof project>

			const items = fish.map((f, i) => {
				const { p, v } = f
				const vl = Math.hypot(v[0], v[1], v[2]) || 1
				const fw: Vec3 = [v[0] / vl, v[1] / vl, v[2] / vl]
				const sdl = Math.hypot(fw[2], fw[0]) || 1
				const side: Vec3 = [-fw[2] / sdl, 0, fw[0] / sdl]
				const up: Vec3 = [
					side[1] * fw[2] - side[2] * fw[1],
					side[2] * fw[0] - side[0] * fw[2],
					side[0] * fw[1] - side[1] * fw[0],
				]
				const scale = FISH_SCALE * f.size
				// A slow yaw of the whole body, and a fast wag of the tail about its hinge.
				const yaw = Math.sin(time * 1.8 + f.phase) * 0.12
				const cy = Math.cos(yaw)
				const sy = Math.sin(yaw)
				const wag = Math.sin(time * TAIL_FREQ + f.phase) * TAIL_AMP
				const toWorld = (lx: number, ly: number, lz: number) => {
					const x = (lx * cy + lz * sy) * scale
					const y = ly * scale
					const z = (-lx * sy + lz * cy) * scale
					return project(
						p[0] + fw[0] * x + up[0] * y + side[0] * z,
						p[1] + fw[1] * x + up[1] * y + side[1] * z,
						p[2] + fw[2] * x + up[2] * y + side[2] * z,
					)
				}
				const body: Point[] = []
				for (let j = 0; j < BODY_SEGMENTS.length; j += 3) {
					body.push(toWorld(BODY_SEGMENTS[j], BODY_SEGMENTS[j + 1], BODY_SEGMENTS[j + 2]))
				}
				const tail = TAIL_OUTLINE.map(([tx, ty]) =>
					toWorld(TAIL_BASE + tx * Math.cos(wag), ty, -tx * Math.sin(wag)),
				)
				return { i, center: project(p[0], p[1], p[2]), body, tail }
			})
			items.sort((a, b) => b.center.depth - a.center.depth)

			const segments = (pts: ReadonlyArray<Point>) => {
				ctx.beginPath()
				for (let j = 0; j < pts.length; j += 2) {
					ctx.moveTo(pts[j].x, pts[j].y)
					ctx.lineTo(pts[j + 1].x, pts[j + 1].y)
				}
				ctx.stroke()
			}
			const loop = (pts: ReadonlyArray<Point>) => {
				ctx.beginPath()
				ctx.moveTo(pts[0].x, pts[0].y)
				for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y)
				ctx.closePath()
				ctx.stroke()
			}

			const baseScale = S / D

			// The router: a solid core inside a slowly turning wireframe halo.
			const hub = project(0, 0, 0)
			const rx = time * 0.05
			const ry = time * 0.15
			const halo = HALO_VERTICES.map(([x, y, z]) => {
				const x1 = x * Math.cos(ry) + z * Math.sin(ry)
				const z1 = -x * Math.sin(ry) + z * Math.cos(ry)
				const y1 = y * Math.cos(rx) - z1 * Math.sin(rx)
				const z2 = y * Math.sin(rx) + z1 * Math.cos(rx)
				return project(x1 * HUB_RADIUS, y1 * HUB_RADIUS, z2 * HUB_RADIUS)
			})
			let hubDrawn = false
			const drawHub = () => {
				ctx.strokeStyle = lumen
				ctx.lineWidth = 0.8 * (hub.k / baseScale)
				for (const [a, b] of HALO_EDGES) {
					// Edges on the far side of the halo sit fainter than the near ones.
					const behind = (halo[a].depth + halo[b].depth) / 2 > D
					ctx.globalAlpha = behind ? 0.18 : 0.45
					ctx.beginPath()
					ctx.moveTo(halo[a].x, halo[a].y)
					ctx.lineTo(halo[b].x, halo[b].y)
					ctx.stroke()
				}
				ctx.globalAlpha = 1
				ctx.fillStyle = lumen
				ctx.beginPath()
				ctx.arc(hub.x, hub.y, HUB_RADIUS * 0.55 * hub.k, 0, Math.PI * 2)
				ctx.fill()
				hubDrawn = true
			}

			ctx.lineJoin = "round"
			// Back to front, with the hub drawn once the school passes its depth.
			for (const it of items) {
				if (!hubDrawn && it.center.depth < D) drawHub()
				const near = Math.max(0, Math.min(1, (D + 0.9 - it.center.depth) / 1.8))
				ctx.strokeStyle = mist
				ctx.lineWidth = 0.8 * (it.center.k / baseScale)
				ctx.globalAlpha = 0.14 + near * 0.6
				segments(it.body)
				loop(it.tail)
			}
			ctx.globalAlpha = 1
			if (!hubDrawn) drawHub()
		}

		const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
		let raf = 0
		let visible = true
		const frame = () => {
			raf = requestAnimationFrame(frame)
			if (!visible) return
			step()
			draw()
		}

		if (reduceMotion) {
			for (let i = 0; i < 300; i++) step()
			draw()
		} else {
			raf = requestAnimationFrame(frame)
		}

		const ro = new ResizeObserver(() => draw())
		ro.observe(canvas)
		const io = new IntersectionObserver(
			(entries) => {
				visible = entries[0]?.isIntersecting ?? true
			},
			{ threshold: 0.01 },
		)
		io.observe(canvas)

		return () => {
			cancelAnimationFrame(raf)
			ro.disconnect()
			io.disconnect()
		}
	}, [])

	return (
		<div aria-hidden="true" className="relative aspect-[4/5] w-full">
			<canvas
				ref={canvasRef}
				className="pointer-events-none absolute -inset-1/4 block size-[150%]"
				style={{
					maskImage: "radial-gradient(closest-side, black 62%, transparent 100%)",
					WebkitMaskImage: "radial-gradient(closest-side, black 62%, transparent 100%)",
				}}
			/>
		</div>
	)
}

/** Fish in a squashed ball around the hub, swimming roughly around the y
 *  axis, each with its own size, pace, depth and tilt. */
function spawnSchool(): Fish[] {
	return Array.from({ length: FISH_COUNT }, () => {
		let x: number
		let y: number
		let z: number
		let r2: number
		do {
			x = Math.random() * 2 - 1
			y = Math.random() * 2 - 1
			z = Math.random() * 2 - 1
			r2 = x * x + y * y + z * z
		} while (r2 > 1 || r2 < 0.2)
		const s = 0.8
		const tilt: Vec3 = [(Math.random() - 0.5) * 0.9, 1, (Math.random() - 0.5) * 0.9]
		const tl = Math.hypot(tilt[0], tilt[1], tilt[2])
		return {
			p: [x * s, y * s * SCHOOL_HEIGHT, z * s],
			v: [z * 0.01, (Math.random() - 0.5) * 0.004, -x * 0.01],
			size: 0.7 + Math.random() * 0.6,
			cruise: 0.002 + Math.random() * 0.0022,
			burst: 0,
			depth: 0.5 + Math.random() * 0.45,
			axis: [tilt[0] / tl, tilt[1] / tl, tilt[2] / tl],
			swirl: 0.5 + Math.random(),
			phase: Math.random() * Math.PI * 2,
			wander: 0.3 + Math.random() * 0.9,
		}
	})
}

/** One boids step: align, cohere and separate within the neighbourhood,
 *  circle the hub on each fish's own axis, hold its own distance from the hub,
 *  wander, and now and then dart. */
function stepSchool(fish: Fish[], time: number) {
	const acc = fish.map((f, i) => {
		const { p, v } = f
		const al: Vec3 = [0, 0, 0]
		const co: Vec3 = [0, 0, 0]
		const se: Vec3 = [0, 0, 0]
		let count = 0
		for (let j = 0; j < fish.length; j++) {
			if (i === j) continue
			const q = fish[j].p
			const dx = q[0] - p[0]
			const dy = q[1] - p[1]
			const dz = q[2] - p[2]
			const d2 = dx * dx + dy * dy + dz * dz
			if (d2 >= 0.1225) continue
			count++
			for (let k = 0; k < 3; k++) {
				al[k] += fish[j].v[k]
				co[k] += q[k]
			}
			if (d2 < 0.0121) {
				const w = 1 / Math.max(d2, 0.0004)
				se[0] -= dx * w
				se[1] -= dy * w
				se[2] -= dz * w
			}
		}
		const a: Vec3 = [0, 0, 0]
		if (count) {
			for (let k = 0; k < 3; k++) {
				a[k] += (al[k] / count - v[k]) * 0.025
				a[k] += (co[k] / count - p[k]) * 0.0004
			}
		}
		const sl = Math.hypot(se[0], se[1], se[2]) || 1
		if (sl > 1) {
			const sm = Math.min(1, sl * 0.01)
			for (let k = 0; k < 3; k++) a[k] += (se[k] / sl) * sm * 0.0015
		}
		const r = Math.hypot(p[0], p[1], p[2]) || 0.001
		const ax = f.axis
		const tangent: Vec3 = [
			ax[1] * p[2] - ax[2] * p[1],
			ax[2] * p[0] - ax[0] * p[2],
			ax[0] * p[1] - ax[1] * p[0],
		]
		const tl = Math.hypot(tangent[0], tangent[1], tangent[2]) || 0.001
		// Distance on a sphere stretched vertically, so the school stands tall.
		const re = Math.hypot(p[0], p[1] / SCHOOL_HEIGHT, p[2]) || 0.001
		const shell = (f.depth - re) * 0.0011
		const outward: Vec3 = [p[0] / re, p[1] / SCHOOL_HEIGHT / re, p[2] / re]
		for (let k = 0; k < 3; k++) {
			a[k] += (tangent[k] / tl) * 0.00018 * f.swirl
			a[k] += outward[k] * shell
			a[k] += Math.sin(time * f.wander + f.phase + k * 2.1) * 0.00014
		}
		if (r < 0.3) for (let k = 0; k < 3; k++) a[k] += (p[k] / r) * 0.002
		return a
	})
	fish.forEach((f, i) => {
		for (let k = 0; k < 3; k++) f.v[k] += acc[i][k]
		if (Math.random() < 0.0004) f.burst = 1
		f.burst *= 0.97
		const speed = Math.hypot(f.v[0], f.v[1], f.v[2]) || 0.001
		const target = f.cruise * (1 + 0.3 * f.burst)
		const eased = speed + (target - speed) * 0.05
		const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, eased))
		for (let k = 0; k < 3; k++) {
			f.v[k] = (f.v[k] / speed) * clamped
			f.p[k] += f.v[k]
		}
	})
}

// The original wireframe fish: a body lofted from elliptical cross-sections,
// drawn as longitudinal ribs and circumferential rings, nose at +x, y up,
// z to the side.
const NOSE = 0.55
const TAIL_BASE = -0.5

/** Line segments as flat [x, y, z] pairs. */
const BODY_SEGMENTS: ReadonlyArray<number> = (() => {
	// [x, height radius, width radius]: taller than wide, widest past the head.
	const sections: ReadonlyArray<readonly [number, number, number]> = [
		[NOSE, 0, 0],
		[0.32, 0.13, 0.08],
		[0.05, 0.18, 0.13],
		[-0.2, 0.14, 0.09],
		[-0.4, 0.06, 0.04],
		[TAIL_BASE, 0, 0],
	]
	const radial = 6
	const ring = (s: number, r: number) => {
		const [x, yR, zR] = sections[s]
		const a = (r / radial) * Math.PI * 2
		return [x, Math.cos(a) * yR, Math.sin(a) * zR]
	}
	const out: number[] = []
	for (let s = 0; s < sections.length - 1; s++) {
		for (let r = 0; r < radial; r++) out.push(...ring(s, r), ...ring(s + 1, r))
	}
	for (let s = 0; s < sections.length; s++) {
		if (sections[s][1] === 0) continue
		for (let r = 0; r < radial; r++) out.push(...ring(s, r), ...ring(s, (r + 1) % radial))
	}
	return out
})()

/** The tail fin, in the x/y plane, hinged at the tail base. */
const TAIL_OUTLINE: ReadonlyArray<readonly [number, number]> = [
	[0, 0.12],
	[-0.32, 0.36],
	[-0.18, 0],
	[-0.32, -0.36],
	[0, -0.12],
]

/** A once-subdivided icosahedron on the unit sphere, as vertices and edges. */
const [HALO_VERTICES, HALO_EDGES] = ((): [Vec3[], Array<[number, number]>] => {
	const t = (1 + Math.sqrt(5)) / 2
	const vertices: Vec3[] = [
		[-1, t, 0],
		[1, t, 0],
		[-1, -t, 0],
		[1, -t, 0],
		[0, -1, t],
		[0, 1, t],
		[0, -1, -t],
		[0, 1, -t],
		[t, 0, -1],
		[t, 0, 1],
		[-t, 0, -1],
		[-t, 0, 1],
	]
	const faces = [
		[0, 11, 5],
		[0, 5, 1],
		[0, 1, 7],
		[0, 7, 10],
		[0, 10, 11],
		[1, 5, 9],
		[5, 11, 4],
		[11, 10, 2],
		[10, 7, 6],
		[7, 1, 8],
		[3, 9, 4],
		[3, 4, 2],
		[3, 2, 6],
		[3, 6, 8],
		[3, 8, 9],
		[4, 9, 5],
		[2, 4, 11],
		[6, 2, 10],
		[8, 6, 7],
		[9, 8, 1],
	]
	const midpoints = new Map<string, number>()
	const midpoint = (a: number, b: number) => {
		const key = a < b ? `${a}-${b}` : `${b}-${a}`
		const known = midpoints.get(key)
		if (known !== undefined) return known
		const [ax, ay, az] = vertices[a]
		const [bx, by, bz] = vertices[b]
		vertices.push([(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2])
		midpoints.set(key, vertices.length - 1)
		return vertices.length - 1
	}
	const edges = new Map<string, [number, number]>()
	const edge = (a: number, b: number) => {
		edges.set(a < b ? `${a}-${b}` : `${b}-${a}`, [a, b])
	}
	for (const [a, b, c] of faces) {
		const ab = midpoint(a, b)
		const bc = midpoint(b, c)
		const ca = midpoint(c, a)
		for (const [x, y, z] of [
			[a, ab, ca],
			[b, bc, ab],
			[c, ca, bc],
			[ab, bc, ca],
		]) {
			edge(x, y)
			edge(y, z)
			edge(z, x)
		}
	}
	const unit = vertices.map(([x, y, z]): Vec3 => {
		const l = Math.hypot(x, y, z)
		return [x / l, y / l, z / l]
	})
	return [unit, [...edges.values()]]
})()
