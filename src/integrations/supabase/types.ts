export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_credentials: {
        Row: {
          api_key: string
          base_url: string
          created_at: string
          id: string
          is_active: boolean
          key_hint: string
          label: string
          model: string
          updated_at: string
          user_id: string
        }
        Insert: {
          api_key: string
          base_url: string
          created_at?: string
          id?: string
          is_active?: boolean
          key_hint?: string
          label?: string
          model: string
          updated_at?: string
          user_id: string
        }
        Update: {
          api_key?: string
          base_url?: string
          created_at?: string
          id?: string
          is_active?: boolean
          key_hint?: string
          label?: string
          model?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      captions_library: {
        Row: {
          body: string
          category: string
          created_at: string
          hashtags: string[]
          id: string
          is_favorite: boolean
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string
          category?: string
          created_at?: string
          hashtags?: string[]
          id?: string
          is_favorite?: boolean
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          category?: string
          created_at?: string
          hashtags?: string[]
          id?: string
          is_favorite?: boolean
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      dna_recipes: {
        Row: {
          created_at: string
          final_duration: number
          hook_id: string | null
          hook_placement: string
          id: string
          project_id: string
          segments: Json
          target_duration: number
          user_id: string
        }
        Insert: {
          created_at?: string
          final_duration?: number
          hook_id?: string | null
          hook_placement?: string
          id?: string
          project_id: string
          segments?: Json
          target_duration?: number
          user_id: string
        }
        Update: {
          created_at?: string
          final_duration?: number
          hook_id?: string | null
          hook_placement?: string
          id?: string
          project_id?: string
          segments?: Json
          target_duration?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dna_recipes_hook_id_fkey"
            columns: ["hook_id"]
            isOneToOne: false
            referencedRelation: "hooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dna_recipes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_videos: {
        Row: {
          audio_id: string | null
          created_at: string
          duration: number
          hook_id: string | null
          hook_text: string | null
          id: string
          is_winner: boolean
          media_asset_id: string | null
          output_url: string | null
          project_id: string
          recipe_id: string | null
          render_job_id: string | null
          status: string
          thumbnail_url: string | null
          user_id: string
        }
        Insert: {
          audio_id?: string | null
          created_at?: string
          duration?: number
          hook_id?: string | null
          hook_text?: string | null
          id?: string
          is_winner?: boolean
          media_asset_id?: string | null
          output_url?: string | null
          project_id: string
          recipe_id?: string | null
          render_job_id?: string | null
          status?: string
          thumbnail_url?: string | null
          user_id: string
        }
        Update: {
          audio_id?: string | null
          created_at?: string
          duration?: number
          hook_id?: string | null
          hook_text?: string | null
          id?: string
          is_winner?: boolean
          media_asset_id?: string | null
          output_url?: string | null
          project_id?: string
          recipe_id?: string | null
          render_job_id?: string | null
          status?: string
          thumbnail_url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_videos_audio_id_fkey"
            columns: ["audio_id"]
            isOneToOne: false
            referencedRelation: "trending_audios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_videos_hook_id_fkey"
            columns: ["hook_id"]
            isOneToOne: false
            referencedRelation: "hooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_videos_media_asset_id_fkey"
            columns: ["media_asset_id"]
            isOneToOne: false
            referencedRelation: "media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_videos_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_videos_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "video_recipes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generated_videos_render_job_id_fkey"
            columns: ["render_job_id"]
            isOneToOne: false
            referencedRelation: "render_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      hook_variants: {
        Row: {
          category: string | null
          created_at: string
          emotional_trigger: string | null
          id: string
          parent_hook_id: string | null
          project_id: string | null
          rationale: string | null
          saved: boolean
          score: number
          structure: string | null
          text: string
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          emotional_trigger?: string | null
          id?: string
          parent_hook_id?: string | null
          project_id?: string | null
          rationale?: string | null
          saved?: boolean
          score?: number
          structure?: string | null
          text: string
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string
          emotional_trigger?: string | null
          id?: string
          parent_hook_id?: string | null
          project_id?: string | null
          rationale?: string | null
          saved?: boolean
          score?: number
          structure?: string | null
          text?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hook_variants_parent_hook_id_fkey"
            columns: ["parent_hook_id"]
            isOneToOne: false
            referencedRelation: "hooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hook_variants_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      hooks: {
        Row: {
          audience: string | null
          category: string
          conversion_rate: number
          created_at: string
          emotional_trigger: string | null
          id: string
          is_winner: boolean
          notes: string | null
          performance_score: number
          platform: string
          project_id: string | null
          retention: number
          saves: number
          shares: number
          source: string
          structure: string | null
          text: string
          updated_at: string
          user_id: string
          views: number
        }
        Insert: {
          audience?: string | null
          category?: string
          conversion_rate?: number
          created_at?: string
          emotional_trigger?: string | null
          id?: string
          is_winner?: boolean
          notes?: string | null
          performance_score?: number
          platform?: string
          project_id?: string | null
          retention?: number
          saves?: number
          shares?: number
          source?: string
          structure?: string | null
          text: string
          updated_at?: string
          user_id: string
          views?: number
        }
        Update: {
          audience?: string | null
          category?: string
          conversion_rate?: number
          created_at?: string
          emotional_trigger?: string | null
          id?: string
          is_winner?: boolean
          notes?: string | null
          performance_score?: number
          platform?: string
          project_id?: string | null
          retention?: number
          saves?: number
          shares?: number
          source?: string
          structure?: string | null
          text?: string
          updated_at?: string
          user_id?: string
          views?: number
        }
        Relationships: [
          {
            foreignKeyName: "hooks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      media_assets: {
        Row: {
          allowed_speeds: number[]
          category: string
          created_at: string
          dna_role: string | null
          duration: number | null
          file_url: string | null
          filename: string
          height: number | null
          hook_placement: string
          id: string
          project_id: string | null
          size_bytes: number | null
          storage_path: string
          tags: string[]
          thumbnail_url: string | null
          user_id: string
          width: number | null
        }
        Insert: {
          allowed_speeds?: number[]
          category?: string
          created_at?: string
          dna_role?: string | null
          duration?: number | null
          file_url?: string | null
          filename: string
          height?: number | null
          hook_placement?: string
          id?: string
          project_id?: string | null
          size_bytes?: number | null
          storage_path: string
          tags?: string[]
          thumbnail_url?: string | null
          user_id: string
          width?: number | null
        }
        Update: {
          allowed_speeds?: number[]
          category?: string
          created_at?: string
          dna_role?: string | null
          duration?: number | null
          file_url?: string | null
          filename?: string
          height?: number | null
          hook_placement?: string
          id?: string
          project_id?: string | null
          size_bytes?: number | null
          storage_path?: string
          tags?: string[]
          thumbnail_url?: string | null
          user_id?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "media_assets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      performance_metrics: {
        Row: {
          avg_watch_time: number
          clicks: number
          comments: number
          completion_rate: number
          conversions: number
          created_at: string
          generated_video_id: string | null
          hook_id: string | null
          id: string
          likes: number
          platform: string
          recorded_at: string
          saves: number
          shares: number
          user_id: string
          views: number
        }
        Insert: {
          avg_watch_time?: number
          clicks?: number
          comments?: number
          completion_rate?: number
          conversions?: number
          created_at?: string
          generated_video_id?: string | null
          hook_id?: string | null
          id?: string
          likes?: number
          platform?: string
          recorded_at?: string
          saves?: number
          shares?: number
          user_id: string
          views?: number
        }
        Update: {
          avg_watch_time?: number
          clicks?: number
          comments?: number
          completion_rate?: number
          conversions?: number
          created_at?: string
          generated_video_id?: string | null
          hook_id?: string | null
          id?: string
          likes?: number
          platform?: string
          recorded_at?: string
          saves?: number
          shares?: number
          user_id?: string
          views?: number
        }
        Relationships: [
          {
            foreignKeyName: "performance_metrics_generated_video_id_fkey"
            columns: ["generated_video_id"]
            isOneToOne: false
            referencedRelation: "generated_videos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "performance_metrics_hook_id_fkey"
            columns: ["hook_id"]
            isOneToOne: false
            referencedRelation: "hooks"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          price: string | null
          project_id: string
          updated_at: string
          url: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          price?: string | null
          project_id: string
          updated_at?: string
          url?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          price?: string | null
          project_id?: string
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          content_style: string
          created_at: string
          id: string
          name: string
          platform: string
          status: string
          target_age: string | null
          target_gender: string | null
          target_interests: string[]
          target_location: string | null
          updated_at: string
          user_id: string
          videos_to_generate: number
        }
        Insert: {
          content_style?: string
          created_at?: string
          id?: string
          name: string
          platform?: string
          status?: string
          target_age?: string | null
          target_gender?: string | null
          target_interests?: string[]
          target_location?: string | null
          updated_at?: string
          user_id: string
          videos_to_generate?: number
        }
        Update: {
          content_style?: string
          created_at?: string
          id?: string
          name?: string
          platform?: string
          status?: string
          target_age?: string | null
          target_gender?: string | null
          target_interests?: string[]
          target_location?: string | null
          updated_at?: string
          user_id?: string
          videos_to_generate?: number
        }
        Relationships: []
      }
      render_feedback: {
        Row: {
          created_at: string
          id: string
          issues: string[]
          project_id: string | null
          rating: string
          reason: string | null
          updated_at: string
          user_id: string
          video_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          issues?: string[]
          project_id?: string | null
          rating: string
          reason?: string | null
          updated_at?: string
          user_id: string
          video_id: string
        }
        Update: {
          created_at?: string
          id?: string
          issues?: string[]
          project_id?: string | null
          rating?: string
          reason?: string | null
          updated_at?: string
          user_id?: string
          video_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "render_feedback_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "generated_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      render_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          output_url: string | null
          progress: number
          project_id: string
          recipe_id: string
          started_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          output_url?: string | null
          progress?: number
          project_id: string
          recipe_id: string
          started_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          output_url?: string | null
          progress?: number
          project_id?: string
          recipe_id?: string
          started_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "render_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "render_jobs_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "video_recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_posts: {
        Row: {
          caption: string
          created_at: string
          error_message: string | null
          generated_video_id: string | null
          id: string
          post_url: string | null
          project_id: string | null
          published_at: string | null
          scheduled_for: string
          social_account_id: string | null
          status: string
          updated_at: string
          upload_post_job_id: string | null
          user_id: string
        }
        Insert: {
          caption?: string
          created_at?: string
          error_message?: string | null
          generated_video_id?: string | null
          id?: string
          post_url?: string | null
          project_id?: string | null
          published_at?: string | null
          scheduled_for?: string
          social_account_id?: string | null
          status?: string
          updated_at?: string
          upload_post_job_id?: string | null
          user_id: string
        }
        Update: {
          caption?: string
          created_at?: string
          error_message?: string | null
          generated_video_id?: string | null
          id?: string
          post_url?: string | null
          project_id?: string | null
          published_at?: string | null
          scheduled_for?: string
          social_account_id?: string | null
          status?: string
          updated_at?: string
          upload_post_job_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_posts_generated_video_id_fkey"
            columns: ["generated_video_id"]
            isOneToOne: false
            referencedRelation: "generated_videos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_posts_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      social_accounts: {
        Row: {
          access_token: string | null
          account_handle: string
          avatar_url: string | null
          created_at: string
          display_name: string | null
          driver: string
          id: string
          last_synced_at: string | null
          open_id: string | null
          platform: string
          profile_identifier: string
          refresh_token: string | null
          scopes: string | null
          status: string
          token_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          account_handle?: string
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          driver?: string
          id?: string
          last_synced_at?: string | null
          open_id?: string | null
          platform?: string
          profile_identifier: string
          refresh_token?: string | null
          scopes?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          account_handle?: string
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          driver?: string
          id?: string
          last_synced_at?: string | null
          open_id?: string | null
          platform?: string
          profile_identifier?: string
          refresh_token?: string | null
          scopes?: string | null
          status?: string
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trending_audios: {
        Row: {
          audio_url: string | null
          author: string | null
          cover_url: string | null
          created_at: string
          duration_seconds: number | null
          external_id: string | null
          id: string
          is_favorite: boolean
          last_synced_at: string | null
          platform: string
          region: string
          source: string
          source_url: string | null
          storage_path: string | null
          title: string
          trend_label: string | null
          trend_rate: number
          updated_at: string
          user_id: string | null
          virality_score: number
        }
        Insert: {
          audio_url?: string | null
          author?: string | null
          cover_url?: string | null
          created_at?: string
          duration_seconds?: number | null
          external_id?: string | null
          id?: string
          is_favorite?: boolean
          last_synced_at?: string | null
          platform?: string
          region?: string
          source?: string
          source_url?: string | null
          storage_path?: string | null
          title: string
          trend_label?: string | null
          trend_rate?: number
          updated_at?: string
          user_id?: string | null
          virality_score?: number
        }
        Update: {
          audio_url?: string | null
          author?: string | null
          cover_url?: string | null
          created_at?: string
          duration_seconds?: number | null
          external_id?: string | null
          id?: string
          is_favorite?: boolean
          last_synced_at?: string | null
          platform?: string
          region?: string
          source?: string
          source_url?: string | null
          storage_path?: string | null
          title?: string
          trend_label?: string | null
          trend_rate?: number
          updated_at?: string
          user_id?: string | null
          virality_score?: number
        }
        Relationships: []
      }
      video_recipes: {
        Row: {
          background_color: string
          created_at: string
          duration: number
          font_size: number
          height: number
          hook_id: string | null
          id: string
          media_asset_id: string | null
          overlay_position: string
          overlay_text: string
          project_id: string
          text_color: string
          user_id: string
          width: number
        }
        Insert: {
          background_color?: string
          created_at?: string
          duration?: number
          font_size?: number
          height?: number
          hook_id?: string | null
          id?: string
          media_asset_id?: string | null
          overlay_position?: string
          overlay_text?: string
          project_id: string
          text_color?: string
          user_id: string
          width?: number
        }
        Update: {
          background_color?: string
          created_at?: string
          duration?: number
          font_size?: number
          height?: number
          hook_id?: string | null
          id?: string
          media_asset_id?: string | null
          overlay_position?: string
          overlay_text?: string
          project_id?: string
          text_color?: string
          user_id?: string
          width?: number
        }
        Relationships: [
          {
            foreignKeyName: "video_recipes_hook_id_fkey"
            columns: ["hook_id"]
            isOneToOne: false
            referencedRelation: "hooks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_recipes_media_asset_id_fkey"
            columns: ["media_asset_id"]
            isOneToOne: false
            referencedRelation: "media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_recipes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
