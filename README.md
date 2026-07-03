## WebShutter

Read the shutter count and other camera info from a Canon EOS DSLR, straight
from the browser over USB — no app install, no native drivers. Uses WebUSB to
talk PTP directly, re-implementing the relevant pieces of
[libgphoto2](https://github.com/gphoto/libgphoto2)'s `ptp2` camlib in
JavaScript.

#### Supported cameras:

1D C, 1D X, 1D Mark IV, 7D Mark II, 7D, 5D Mark III, 5D Mark II, 6D,
70D, 60D, 50D, 40D, 700D, 650D, 600D, 550D, 500D, 100D, 1200D, 1100D, 1000D

_Theoretically. Only tested with my 7D._ 

## Requirements

- A Chromium-based browser (Chrome / Edge / Opera). WebUSB is not supported in Firefox or Safari.
- Camera set to **PTP** communication mode.

