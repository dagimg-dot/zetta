import { expect, test } from "bun:test";
import { matchRefs, refName } from "./refs";

test("a table in the schema on show is named without its schema", () => {
	expect(refName({ schema: "auth", table: "roles" }, "auth")).toBe("roles");
	expect(refName({ schema: "task", table: "tasks" }, "auth")).toBe("task.tasks");
});

test("references filter by table or column, ignoring case", () => {
	const refs = [
		{ label: "flagged_devices", detail: "flagged_by_id" },
		{ label: "flagged_devices", detail: "source_user_id" },
		{ label: "task.tasks", detail: "assignee" },
	];
	expect(matchRefs(refs, "TASK")).toEqual([refs[2]]);
	expect(matchRefs(refs, "source")).toEqual([refs[1]]);
	expect(matchRefs(refs, "flagged")).toEqual([refs[0], refs[1]]);
	expect(matchRefs(refs, "  ")).toBe(refs);
	expect(matchRefs(refs, "orders")).toEqual([]);
});
