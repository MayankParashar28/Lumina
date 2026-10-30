const util = require("util");
const winston = require('winston');

// Describe an extra log argument as text. Errors contribute their stack, which is
// the whole point of logging them.
function describe(value) {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    try {
        return JSON.stringify(value);
    } catch (_) {
        return String(value);
    }
}

// 🩹 Fold trailing arguments into the message.
//
// The codebase logs errors as `logger.error("Thing failed:", err.stack)` and
// `logger.error("Thing failed:", err.message)` in ~28 places. Winston treats a
// second argument as splat metadata, and with only timestamp+json in the format
// chain that string was dropped on the floor — those lines logged a bare message
// with no indication of what actually went wrong. Keep printf-style calls
// (`logger.info("Sent: %s", id)`) working too.
const expandArgs = winston.format((info) => {
    const splat = info[Symbol.for("splat")];
    if (!splat || !splat.length) return info;

    const message = String(info.message);
    if (/%[sdifjoOc%]/.test(message)) {
        info.message = util.format(message, ...splat);
        return info;
    }

    // Drop any Error whose stack the errors() format above already captured onto
    // `info`, so it isn't printed twice.
    const extras = splat
        .filter((v) => !(v instanceof Error && v.stack && v.stack === info.stack))
        .map(describe);

    if (extras.length) info.message = [message, ...extras].join(" ");
    return info;
});

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.errors({ stack: true }), // keep stacks when an Error is the message
        expandArgs(),
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'blogify-service' },
    // Tests shouldn't spray the repo with log files or noise up the output.
    silent: process.env.NODE_ENV === 'test',
    transports: [
        //
        // - Write all logs with importance level of `error` or less to `error.log`
        // - Write all logs with importance level of `info` or less to `combined.log`
        //
        // Both are capped and rotated: unbounded log files on a small instance
        // eventually fill the disk.
        new winston.transports.File({
            filename: 'error.log',
            level: 'error',
            maxsize: 5 * 1024 * 1024, // 5MB
            maxFiles: 5,
            tailable: true,
        }),
        new winston.transports.File({
            filename: 'combined.log',
            maxsize: 5 * 1024 * 1024, // 5MB
            maxFiles: 5,
            tailable: true,
        }),
    ],
});

//
// Always log to the console. Hosting platforms (Render, Heroku, Fly, Docker)
// capture stdout/stderr and show that as "the logs" — they never read files
// from inside the container, and the container filesystem is wiped on every
// restart. Without this transport, production errors go only to the files
// above, i.e. nowhere anyone will ever look, and an empty log stream reads as
// "healthy" when it actually means "blind".
//
// Production gets the logger's structured JSON (one object per line, which log
// aggregators can parse); development gets the short colorized form.
logger.add(new winston.transports.Console(
    process.env.NODE_ENV === 'production'
        ? {} // inherit the JSON format defined on the logger above
        : {
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
        }
));

module.exports = logger;
