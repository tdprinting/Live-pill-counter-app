import SwiftUI

@main
struct PillCountApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    var body: some View {
        WebContainer()
            .ignoresSafeArea()
            .background(Color.black)
            .preferredColorScheme(.dark)
    }
}
