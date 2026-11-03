import type { JSX } from "solid-js";

const paths = {
	sort: () => <path d="M3.5 4.5 6 2l2.5 2.5M3.5 7.5 6 10l2.5-2.5" />,
	asc: () => <path d="M6 10V2M3 5l3-3 3 3" />,
	desc: () => <path d="M6 2v8M3 7l3 3 3-3" />,
	more: () => <path d="M3 6h.01M6 6h.01M9 6h.01" stroke-width="2.2" />,
	up: () => <path d="M3 7.5 6 4.5l3 3" />,
	filter: () => <path d="M1.5 2.5h9L7 6.4v3.1l-2 1V6.4Z" />,
	code: () => <path d="M4 3.5 1.5 6 4 8.5M8 3.5 10.5 6 8 8.5" />,
	plus: () => <path d="M6 2.5v7M2.5 6h7" />,
	go: () => <path d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4" />,
	bolt: () => <path d="M6.8 1.2 2.8 6.6h3l-.6 4.2 4-5.4h-3Z" />,
	fold: () => <path d="M2 3l2.5 3L2 9M10 3 7.5 6 10 9" />,
	unfold: () => <path d="M4.5 3 2 6l2.5 3M7.5 3 10 6 7.5 9" />,
	key: () => (
		<>
			<circle cx="3.8" cy="6" r="2.2" />
			<path d="M6 6h4.5M9 6v1.8M10.5 6v1.4" />
		</>
	),
	refresh: () => (
		<>
			<path d="M10 6a4 4 0 1 1-1.17-2.83" />
			<path d="M9.4 1.4v2.4H7" />
		</>
	),
	chevron: () => <path d="M4.5 2.8 7.7 6l-3.2 3.2" />,
	table: () => (
		<>
			<rect x="1.5" y="2" width="9" height="8" rx="1.2" />
			<path d="M1.5 5h9M5 5v5" />
		</>
	),
	view: () => (
		<>
			<path d="M1 6s1.8-3.5 5-3.5S11 6 11 6s-1.8 3.5-5 3.5S1 6 1 6Z" />
			<circle cx="6" cy="6" r="1.4" />
		</>
	),
	database: () => (
		<>
			<ellipse cx="6" cy="2.8" rx="4" ry="1.4" />
			<path d="M2 2.8v6.4c0 .8 1.8 1.4 4 1.4s4-.6 4-1.4V2.8M2 6c0 .8 1.8 1.4 4 1.4S10 6.8 10 6" />
		</>
	),
	lock: () => (
		<>
			<rect x="2.5" y="5.5" width="7" height="5" rx="1" />
			<path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
		</>
	),
	search: () => (
		<>
			<circle cx="5.2" cy="5.2" r="3.2" />
			<path d="m7.6 7.6 2.6 2.6" />
		</>
	),
	play: () => <path d="M3.5 2.3v7.4L9.8 6Z" />,
	first: () => <path d="M6.5 2.8 3.3 6l3.2 3.2M9.5 2.8 6.3 6l3.2 3.2" />,
	last: () => <path d="M5.5 2.8 8.7 6 5.5 9.2M2.5 2.8 5.7 6 2.5 9.2" />,
	prev: () => <path d="M7.5 2.8 4.3 6l3.2 3.2" />,
	next: () => <path d="M4.5 2.8 7.7 6l-3.2 3.2" />,
	alert: () => (
		<>
			<circle cx="6" cy="6" r="4.6" />
			<path d="M6 3.6v2.8M6 8.3v.1" />
		</>
	),
	warn: () => (
		<>
			<path d="M6 1.6 11 10.4H1Z" />
			<path d="M6 5v2.2M6 8.8v.1" />
		</>
	),
	check: () => <path d="m2.5 6.3 2.3 2.3 4.7-5" />,
	close: () => <path d="M3 3l6 6M9 3 3 9" />,
	copy: () => (
		<>
			<rect x="4" y="4" width="6" height="6" rx="1" />
			<path d="M8 4V2.8a.8.8 0 0 0-.8-.8H2.8a.8.8 0 0 0-.8.8v4.4a.8.8 0 0 0 .8.8H4" />
		</>
	),
	menu: () => <path d="M2 3.5h8M2 6h8M2 8.5h8" />,
	help: () => (
		<>
			<circle cx="6" cy="6" r="4.6" />
			<path d="M4.7 4.7a1.4 1.4 0 1 1 1.9 1.3c-.4.2-.6.5-.6.9M6 8.4v.1" />
		</>
	),
	inspect: () => (
		<>
			<rect x="1.5" y="2" width="9" height="8" rx="1.2" />
			<path d="M7 2v8" />
		</>
	),
	sun: () => (
		<>
			<circle cx="6" cy="6" r="2.3" />
			<path d="M6 1v1.2M6 9.8V11M1 6h1.2M9.8 6H11M2.5 2.5l.8.8M8.7 8.7l.8.8M2.5 9.5l.8-.8M8.7 3.3l.8-.8" />
		</>
	),
	moon: () => <path d="M9.8 7.4A4.2 4.2 0 0 1 4.6 2.2a4.2 4.2 0 1 0 5.2 5.2Z" />,
	monitor: () => (
		<>
			<rect x="1.3" y="2" width="9.4" height="6.3" rx="1" />
			<path d="M4.2 10.4h3.6M6 8.3v2.1" />
		</>
	),
} satisfies Record<string, () => JSX.Element>;

export type IconName = keyof typeof paths;

export function Icon(props: { name: IconName; size?: number; class?: string }) {
	return (
		<svg
			class={props.class ? `icon ${props.class}` : "icon"}
			width={props.size ?? 12}
			height={props.size ?? 12}
			viewBox="0 0 12 12"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			{paths[props.name]()}
		</svg>
	);
}

const ON = [[0, 1, 2, 3], [2], [1], [0, 1, 2, 3]];

/** The Grid Z mark: a 4×4 cell grid on an Ember tile, with the Z cells lit. */
export function Mark(props: { size?: number }) {
	const cells = [];
	for (let row = 0; row < 4; row++) {
		for (let col = 0; col < 4; col++) {
			cells.push({ x: 10 + col * 12, y: 10 + row * 12, on: ON[row]?.includes(col) ?? false });
		}
	}
	return (
		<svg
			class="icon"
			width={props.size ?? 18}
			height={props.size ?? 18}
			viewBox="0 0 64 64"
			aria-hidden="true"
		>
			<rect width="64" height="64" rx="14" fill="#ea580c" />
			{cells.map((c) => (
				<rect
					x={c.x}
					y={c.y}
					width="8"
					height="8"
					rx="2"
					fill="#fff"
					opacity={c.on ? undefined : 0.22}
				/>
			))}
		</svg>
	);
}
