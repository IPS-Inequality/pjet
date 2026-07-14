Vendored from https://github.com/bartvm/flight-emissions

Commit: 2bc9f9dad07436a2ffa411c68f7ade41f9b5d9ca
License: Apache-2.0, see LICENSE in this directory.

This copy is used by the Node backend through `server/ghgc_bridge.py`.

PJET locally modifies `ghgc/methods/eurocontrol.py` and
`scripts/airport_guide.py` to remove embedded credentials and non-redistributable
SET curve data. See the modified file headers and PJET's README for configuration.
