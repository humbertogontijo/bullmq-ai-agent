export type OptionalIfUndefined<T> = {
    [K in keyof T as undefined extends T[K] ? K : never]?: T[K]
} & {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K]
}
