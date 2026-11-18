/** « 1 saison », « 3 saisons » : le nombre suivi du mot accordé (pluriel au-delà de 1, comme en français). */
export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
