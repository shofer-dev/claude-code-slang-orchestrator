# Benchmark target scaffold

A minimal TypeScript + vitest project. The benchmark's agents implement small `src/utils`
helpers here and run `vitest`; the harness resets it (`git checkout`/`clean`) between runs.
Self-contained on purpose — the benchmark needs no private repo. Built by
`harness/setup_target.sh` into `$BENCH_WORKDIR`.
