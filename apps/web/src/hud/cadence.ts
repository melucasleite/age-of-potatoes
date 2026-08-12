// How often the HUD hears about the world.
//
// THREE TICKS, AND THE THREE IS AN INFERENCE WORTH RECORDING. Plan §13's band is 4–8 Hz.
// At a 50 ms tick, exactly 8 Hz is not a whole number of ticks (20 ÷ 8 = 2.5), and a
// non-integer cadence has to be tracked by something — which means a second clock in an
// app whose entire architecture rests on having exactly one. Every third tick is 6.67 Hz:
// inside the band, tick-aligned, and countable with an integer that the existing loop
// already advances.
//
// The throttle IS the optimization. It removes roughly two thirds of the React work before
// any memoization cleverness, it costs nothing anybody can perceive, and retrofitting it
// later means re-testing every panel that was written against a 20 Hz feed.
//
// This lives in its own file so `GameHost` can import the number without pulling the React
// tree — and so the number has somewhere to be explained.

export const HUD_PUBLISH_EVERY_TICKS = 3;
