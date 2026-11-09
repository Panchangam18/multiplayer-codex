import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
func drawIcon() {
    let background = NSBezierPath(roundedRect: NSRect(x: 20, y: 20, width: 472, height: 472), xRadius: 112, yRadius: 112)
    NSGradient(starting: NSColor(calibratedRed: 0.12, green: 0.34, blue: 0.32, alpha: 1), ending: NSColor(calibratedRed: 0.09, green: 0.17, blue: 0.22, alpha: 1))!.draw(in: background, angle: -65)
    let bubble = NSBezierPath(roundedRect: NSRect(x: 96, y: 144, width: 320, height: 244), xRadius: 70, yRadius: 70)
    NSColor(calibratedRed: 0.79, green: 0.92, blue: 0.86, alpha: 1).setFill()
    bubble.fill()
    let tail = NSBezierPath()
    tail.move(to: NSPoint(x: 132, y: 174))
    tail.line(to: NSPoint(x: 132, y: 105))
    tail.line(to: NSPoint(x: 209, y: 158))
    tail.close()
    tail.fill()
    for (center, shade) in [(210.0, 0.28), (309.0, 0.44)] {
        NSColor(calibratedRed: 0.13, green: shade, blue: 0.34, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: center - 30, y: 282, width: 60, height: 60)).fill()
        NSBezierPath(roundedRect: NSRect(x: center - 47, y: 201, width: 94, height: 65), xRadius: 30, yRadius: 30).fill()
    }
}
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let transform = NSAffineTransform()
        transform.scale(by: CGFloat(pixels) / 512)
        transform.concat()
        drawIcon()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
