import type { JSX } from "solid-js";

const paths = {
	sort: () => <path d="M3.5 4.5 6 2l2.5 2.5M3.5 7.5 6 10l2.5-2.5" />,
	asc: () => <path d="M6 10V2M3 5l3-3 3 3" />,
	desc: () => <path d="M6 2v8M3 7l3 3 3-3" />,
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
	prev: () => <path d="M7.5 2.8 4.3 6l3.2 3.2" />,
	next: () => <path d="M4.5 2.8 7.7 6l-3.2 3.2" />,
	alert: () => (
		<>
			<circle cx="6" cy="6" r="4.6" />
			<path d="M6 3.6v2.8M6 8.3v.1" />
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
