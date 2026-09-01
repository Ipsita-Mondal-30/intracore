import { requirePermission } from "@/lib/tenant";
import { getNotificationPreferences } from "@/lib/notifications/queries";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotificationPreferencesForm } from "@/features/notifications/preferences-form";

export default async function NotificationSettingsPage() {
  const tenant = await requirePermission("dashboard.view");
  const prefs = await getNotificationPreferences(tenant);

  return (
    <div>
      <PageHeader
        breadcrumbs={["Settings", "Notifications"]}
        title="Notifications"
        subtitle="Choose what you want to be notified about"
      />
      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
        </CardHeader>
        <CardContent>
          <NotificationPreferencesForm prefs={prefs} />
        </CardContent>
      </Card>
    </div>
  );
}
