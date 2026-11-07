// Months loads apart from the first screen (the web's 500 kB first-load budget), in one chunk with Money; tabs fetch it once they have drawn, so the tab opens at once.
export const loadMonths = () => import('../tabs')
