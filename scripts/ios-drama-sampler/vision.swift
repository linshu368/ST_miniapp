import Foundation
import Vision
import AppKit

// Vision stays local. Bounding boxes are normalized top-left coordinates, independent of Retina scale.
guard CommandLine.arguments.count == 2,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("usage: vision image.png\n", stderr)
    exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    let rows: [[String: Any]] = (request.results ?? []).compactMap { result in
        guard let text = result.topCandidates(1).first, text.confidence >= 0.3 else { return nil }
        let box = result.boundingBox
        return ["text": text.string, "x": box.minX, "y": 1 - box.maxY,
                "width": box.width, "height": box.height, "confidence": text.confidence]
    }
    let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    fputs("local Vision recognition failed\n", stderr)
    exit(1)
}
