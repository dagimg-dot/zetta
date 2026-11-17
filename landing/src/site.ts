export const links = {
	repo: "https://github.com/dagimg-dot/zetta",
	releases: "https://github.com/dagimg-dot/zetta/releases/latest",
	docker: "https://hub.docker.com/r/workflowjd/zetta",
	license: "https://github.com/dagimg-dot/zetta/blob/main/LICENSE",
	issues: "https://github.com/dagimg-dot/zetta/issues",
};

export const installCmd =
	"curl -fsSL https://raw.githubusercontent.com/dagimg-dot/zetta/main/install.sh | sh";

/** The compose file the Compose section shows, as the copy button copies it. */
export const composeYaml = `services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: postgres

  zetta:
    image: workflowjd/zetta
    ports: ["127.0.0.1:1993:1993"]
    environment:
      ZETTA_TOKEN: \${ZETTA_TOKEN}
      DATABASE_URL: postgres://postgres:postgres@db:5432/postgres
    depends_on: [db]
`;

/**
 * One line, so pasting it does not run it before the URL is edited. Inside the
 * container zetta needs a token; it prints a localhost link that carries it.
 */
export const dockerCmd =
	"docker run --rm -p 127.0.0.1:1993:1993 -e ZETTA_TOKEN=$(openssl rand -hex 16) -e DATABASE_URL=postgres://user:password@host:5432/app workflowjd/zetta";
