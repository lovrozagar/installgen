# The e2e image for the generated install.sh: dash, bash and zsh, with curl, unzip and util-linux `script` for TTY runs.
FROM debian:13-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates curl dash unzip util-linux zsh \
	&& rm -rf /var/lib/apt/lists/*
