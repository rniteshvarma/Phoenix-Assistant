import SwiftUI

/// The Booking Approval Card (Phase 6): the whole deal, readable at a glance, before Phoenix
/// fills in anything. Shown in the Summon Bar's approval card for `booking_review`.
struct BookingInfo {
    let kind: String
    let title: String
    let site: String
    let itinerary: [String]
    let travellers: [String]
    let base, taxes, fees, addOns: Double?
    let total: Double
    let cancellation: String
    let payment: String
    let notes: String?

    init?(json: String) {
        guard let data = json.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let price = o["price"] as? [String: Any], let total = (price["total"] as? NSNumber)?.doubleValue else { return nil }
        kind = o["kind"] as? String ?? "booking"
        title = o["title"] as? String ?? ""
        site = o["site"] as? String ?? ""
        itinerary = o["itinerary"] as? [String] ?? []
        travellers = o["travellers"] as? [String] ?? []
        base = (price["base"] as? NSNumber)?.doubleValue
        taxes = (price["taxes"] as? NSNumber)?.doubleValue
        fees = (price["fees"] as? NSNumber)?.doubleValue
        addOns = (price["addOns"] as? NSNumber)?.doubleValue
        self.total = total
        cancellation = o["cancellation"] as? String ?? ""
        payment = o["payment"] as? String ?? ""
        notes = o["notes"] as? String
    }

    static func rupees(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_IN")
        f.maximumFractionDigits = v.rounded() == v ? 0 : 2
        return "₹" + (f.string(from: NSNumber(value: v)) ?? String(v))
    }

    var icon: String {
        switch kind {
        case "flight": return "airplane"
        case "hotel": return "bed.double.fill"
        case "train": return "tram.fill"
        case "cab": return "car.fill"
        case "bus": return "bus.fill"
        default: return "ticket.fill"
        }
    }
}

struct BookingCardView: View {
    let info: BookingInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: info.icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(Fire.flame)
                VStack(alignment: .leading, spacing: 2) {
                    Text(info.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Ember.text).fixedSize(horizontal: false, vertical: true)
                    Text("on \(info.site)").font(.system(size: 11.5)).foregroundStyle(Ember.dim)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 1) {
                    Text(BookingInfo.rupees(info.total)).font(.system(size: 22, weight: .bold, design: .rounded)).foregroundStyle(Ember.text)
                    Text("TOTAL").font(.system(size: 9.5, weight: .semibold, design: .monospaced)).tracking(1.2).foregroundStyle(Ember.dim)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(info.itinerary, id: \.self) { line in
                    HStack(alignment: .top, spacing: 8) {
                        Circle().fill(Fire.ember).frame(width: 5, height: 5).padding(.top, 6)
                        Text(line).font(.system(size: 12.5)).foregroundStyle(Ember.text)
                    }
                }
                if !info.travellers.isEmpty {
                    Label(info.travellers.joined(separator: ", "), systemImage: "person.2.fill").font(.system(size: 11.5)).foregroundStyle(Ember.dim)
                }
            }
            let parts: [(String, Double?)] = [("Base fare", info.base), ("Taxes", info.taxes), ("Fees", info.fees), ("Add-ons", info.addOns)]
            if parts.contains(where: { $0.1 != nil }) {
                VStack(spacing: 3) {
                    ForEach(parts.filter { $0.1 != nil }, id: \.0) { p in
                        HStack {
                            Text(p.0).foregroundStyle(Ember.dim)
                            Spacer()
                            Text(BookingInfo.rupees(p.1!)).foregroundStyle(Ember.text).monospacedDigit()
                        }
                        .font(.system(size: 12))
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.25)))
            }
            Label(info.cancellation, systemImage: "arrow.uturn.backward.circle").font(.system(size: 11.5)).foregroundStyle(Ember.text.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
            Label("\(info.payment). \(Persona.name) stops at the payment page: you pay, and enter any OTP or UPI PIN.", systemImage: "creditcard")
                .font(.system(size: 11.5)).foregroundStyle(Fire.amber).fixedSize(horizontal: false, vertical: true)
            if let notes = info.notes, !notes.isEmpty {
                Text(notes).font(.system(size: 11.5)).foregroundStyle(Ember.dim).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Fire.ember.opacity(0.35), lineWidth: 1))
    }
}
