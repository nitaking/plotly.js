#!/usr/bin/env bash

go()
{
  echo "Starting container orca$2"
  docker run -d --name orca$2 -v $(pwd):$(pwd) -w $(pwd) -e CIRCLECI=true -e CIRCLE_NODE_TOTAL=$1 -e CIRCLE_NODE_INDEX=$2 --entrypoint .circleci/retry-orca-build-verify.js antoinerg/orca-reproducible
}

wait()
{
  docker wait orca$1 && docker rm orca$1
}

go 4 0
go 4 1
go 4 2
go 4 3

echo "Waiting for containers to exit"
wait 0 && \
wait 1 && \
wait 2 && \
wait 3
