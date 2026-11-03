import { Icon } from "../ui/icons";

export function Unauthorized() {
	return (
		<div class="gate">
			<div class="card" role="alert">
				<h1>
					<Icon name="lock" size={16} />
					This session is not signed in
				</h1>
				<p>
					zetta only answers browsers that opened the link it printed at startup. Open the URL from
					the terminal where you ran <code>zetta serve</code>, the one ending in{" "}
					<code>?token=…</code>.
				</p>
				<p>If zetta was restarted, it printed a new link and the old one no longer works.</p>
			</div>
		</div>
	);
}
